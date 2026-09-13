"""Async SQLAlchemy engine wired for TimescaleDB Cloud.

asyncpg does not understand libpq's ``sslmode`` query parameter, so the
URL is normalised here: the scheme is swapped to ``postgresql+asyncpg``
and any ``sslmode``/``channel_binding`` params are translated into an
``ssl`` connect argument.
"""

import ssl
from collections.abc import AsyncIterator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from .config import get_settings

# libpq params asyncpg rejects; handled out-of-band via connect_args.
_LIBPQ_ONLY = {"sslmode", "channel_binding", "sslrootcert", "target_session_attrs"}


class Base(DeclarativeBase):
    pass


def normalise_db_url(raw: str) -> tuple[str, dict]:
    """Return an asyncpg-compatible URL plus connect_args."""
    if not (raw or "").strip():
        raise RuntimeError(
            "DATABASE_URL is not set. Copy backend/.env.example to "
            "backend/.env and fill in the connection string."
        )

    parts = urlsplit(raw)

    # Only Postgres URLs need rewriting. Passing anything else (sqlite for
    # local runs and tests) through urlunsplit would collapse the empty
    # netloc in "sqlite:///path" down to "sqlite:/path".
    if not parts.scheme.startswith(("postgres", "postgresql")):
        return raw, {}

    scheme = "postgresql+asyncpg"

    query = parse_qsl(parts.query, keep_blank_values=True)
    kept, sslmode = [], None
    for key, value in query:
        if key.lower() == "sslmode":
            sslmode = value.lower()
        elif key.lower() in _LIBPQ_ONLY:
            continue
        else:
            kept.append((key, value))

    url = urlunsplit((scheme, parts.netloc, parts.path, urlencode(kept), parts.fragment))

    connect_args: dict = {}
    if sslmode in ("require", "prefer", "allow"):
        # Timescale Cloud serves a cert chain that is not in every local
        # trust store; require encryption without demanding verification.
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        connect_args["ssl"] = ctx
    elif sslmode in ("verify-ca", "verify-full"):
        connect_args["ssl"] = ssl.create_default_context()
    elif sslmode == "disable":
        connect_args["ssl"] = False

    return url, connect_args


_settings = get_settings()
_url, _connect_args = normalise_db_url(_settings.database_url)

_engine_kwargs: dict = {"connect_args": _connect_args, "echo": False}
if _url.startswith("postgresql"):
    # SQLite's async pool does not take these.
    _engine_kwargs.update(pool_pre_ping=True, pool_size=5, max_overflow=5)

engine = create_async_engine(_url, **_engine_kwargs)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


async def init_models() -> None:
    from . import models  # noqa: F401  (register mappers)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
