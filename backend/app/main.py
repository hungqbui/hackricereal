import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import engine, init_models
from .routers import auth, dining, plans, profile
from .services.dineoncampus import DineOnCampusClient

logger = logging.getLogger("cougargrub")
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.dineoncampus = DineOnCampusClient()
    try:
        await init_models()
    except Exception:
        # A cold database should not stop the dining endpoints from serving.
        logger.exception("Database initialisation failed; /dining still works.")
    yield
    await app.state.dineoncampus.aclose()
    await engine.dispose()


app = FastAPI(
    title="CougarGrub API",
    version="1.0.0",
    description=(
        "AI meal planning over University of Houston DineOnCampus menus. "
        "Gemini selects items; the server recomputes every macro from the "
        "real menu payload."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(dining.router)
app.include_router(plans.router)
app.include_router(profile.router)


@app.get("/health", tags=["meta"])
async def health() -> dict:
    """Liveness plus which optional integrations are wired up."""
    from sqlalchemy import text

    db_ok = True
    db_error = None
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:
        db_ok = False
        # /health is unauthenticated: report only the error class, never
        # the driver message, which carries the host, user and database.
        db_error = type(exc).__name__
        logger.warning("Database health check failed", exc_info=True)

    return {
        "status": "ok",
        "database": {"connected": db_ok, "error": db_error},
        "gemini": {
            "configured": settings.gemini_enabled,
            "model": settings.gemini_model if settings.gemini_enabled else None,
        },
    }
