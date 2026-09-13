from fastapi import APIRouter
from sqlalchemy.exc import IntegrityError

from ..deps import CurrentUser, SessionDep
from ..models import UserProfile
from ..schemas import ProfileOut, ProfileUpdate

router = APIRouter(prefix="/profile", tags=["profile"])

# The only column that may be cleared; an explicit null anywhere else in a
# partial update means "leave it as it is".
_NULLABLE = {"display_name"}


@router.get("", response_model=ProfileOut)
async def get_profile(user: CurrentUser, session: SessionDep) -> ProfileOut:
    row = await session.get(UserProfile, user.id)
    # No row exists until the first save.
    return ProfileOut.model_validate(row) if row is not None else ProfileOut()


@router.put("", response_model=ProfileOut)
async def update_profile(
    payload: ProfileUpdate, user: CurrentUser, session: SessionDep
) -> ProfileOut:
    changes = {
        field: value
        for field, value in payload.model_dump(exclude_unset=True).items()
        if value is not None or field in _NULLABLE
    }

    # The Profile screen saves per setting, so two first saves can race to
    # insert the row; the loser retries as an update.
    for attempt in range(2):
        row = await session.get(UserProfile, user.id)
        if row is None:
            row = UserProfile(user_id=user.id)
            session.add(row)
        for field, value in changes.items():
            setattr(row, field, value)
        try:
            await session.commit()
            break
        except IntegrityError:
            await session.rollback()
            if attempt:
                raise

    await session.refresh(row)
    return ProfileOut.model_validate(row)
