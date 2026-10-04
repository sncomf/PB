"""Manual renewal: panel → duration → plan, then paid confirmation."""

from fastapi import APIRouter
from pasarguard import GroupsResponse, PasarguardAPI, UserModify

from app.db.crud.discount_codes import DiscountCodeManager
from app.db.crud.panels import PanelsManager
from app.db.crud.plans import PlanManager
from app.db.crud.services import ServiceCRUD
from app.db.crud.user import UserCRUD
from app.logger import LogType, get_logger
from app.models.webapp import (
    RenewPanelItem,
    RenewPlanItem,
    WebAppRenewConfirmRequest,
    WebAppRenewConfirmResponse,
    WebAppRenewOptionsRequest,
    WebAppRenewOptionsResponse,
    WebAppRenewPlansRequest,
    WebAppRenewPlansResponse,
)
from app.routers.webapp.auth import authenticate_user
from app.routers.webapp.state import renew_confirm_locks
from app.services.billing.renewal import PaidRenewalError, execute_paid_service_renewal, require_panel_userid
from app.services.panels.settings import panel_default_group_ids, panel_display_mode, panel_shop_sale_enabled
from app.services.send_queue import enqueue
from app.utils.formatting.dates import Time_Date
from app.utils.formatting.traffic import format_size

logger = get_logger(__name__)
router = APIRouter()


def _plan_item(p) -> RenewPlanItem:
    return RenewPlanItem(
        id=int(p.id),
        storage=float(p.storage),
        duration=int(p.duration),
        price=int(p.price),
        plan_type=getattr(p, "plan_type", None) or "volume",
        data_limit_reset_strategy=getattr(p, "data_limit_reset_strategy", None) or "no_reset",
        ip_limit=int(getattr(p, "ip_limit", 0) or 0),
    )


def _filter_plans_for_service(plans: list, is_fair_usage: bool) -> list:
    if is_fair_usage:
        return [p for p in plans if getattr(p, "plan_type", None) in ("fair_usage", "fair")]
    return [p for p in plans if getattr(p, "plan_type", None) not in ("fair_usage", "fair")]


async def _service_is_fair_usage(service, panel_code: int) -> bool:
    if not service.package_size:
        return False
    current_plan = await PlanManager().get_plan_by_volume_for_display(
        gb=float(service.package_size) / (1024**3),
        panel_code=panel_code,
    )
    return bool(current_plan and getattr(current_plan, "plan_type", None) in ("fair_usage", "fair"))


async def _load_owned_service(user_id: int, code: int):
    service_crud = ServiceCRUD()
    found, service = await service_crud.get_service(code)
    if not found or not service or int(service.id) != user_id:
        return None
    if getattr(service, "is_test", False) is True:
        return None
    return service


def resolve_group_ids(panel, groups_resp: GroupsResponse) -> list[int]:
    selected = sorted(panel_default_group_ids(panel))
    if selected:
        return selected
    groups = getattr(groups_resp, "groups", None) or []
    return [int(g.id) for g in groups if getattr(g, "id", None) is not None]


@router.post("/webapp/renew/options", response_model=WebAppRenewOptionsResponse)
async def get_renew_options(request: WebAppRenewOptionsRequest) -> WebAppRenewOptionsResponse:
    try:
        user_id = await authenticate_user(init_data=request.init_data, session_token=request.session_token)
        service = await _load_owned_service(user_id, request.code)
        if not service:
            return WebAppRenewOptionsResponse(ok=False, error="سرویس یافت نشد یا قابل تمدید نیست")

        current_panel = await PanelsManager().get_panel_by_code(service.in_panel)
        if not current_panel:
            return WebAppRenewOptionsResponse(ok=False, error="پنل سرویس یافت نشد")

        panels = await PanelsManager().get_available_panels()
        # فقط پنل‌هایی که فروش/تمدید برایشان معنی دارد (فعال + فروشگاه)
        panels = [p for p in panels if panel_shop_sale_enabled(p) or int(p.code) == int(service.in_panel)]
        if not panels:
            panels = [current_panel]

        codes = [int(p.code) for p in panels]
        durations_by_panel = await PlanManager().get_unique_durations_for_panels(codes)

        panel_items: list[RenewPanelItem] = []
        for panel in panels:
            panel_items.append(
                RenewPanelItem(
                    code=int(panel.code),
                    name=panel.name,
                    display_mode=panel_display_mode(panel),
                    durations=[int(d) for d in durations_by_panel.get(int(panel.code), [])],
                )
            )

        is_fair = await _service_is_fair_usage(service, int(service.in_panel))

        return WebAppRenewOptionsResponse(
            ok=True,
            service_code=str(request.code),
            current_panel_code=int(service.in_panel),
            current_panel_name=getattr(current_panel, "name", None) or "پنل",
            is_fair_usage=is_fair,
            panels=panel_items,
        )
    except ValueError as e:
        return WebAppRenewOptionsResponse(ok=False, error=str(e))
    except Exception as e:
        logger.exception("renew options failed: %s", e)
        return WebAppRenewOptionsResponse(ok=False, error=str(e))


@router.post("/webapp/renew/plans", response_model=WebAppRenewPlansResponse)
async def get_renew_plans(request: WebAppRenewPlansRequest) -> WebAppRenewPlansResponse:
    try:
        user_id = await authenticate_user(init_data=request.init_data, session_token=request.session_token)
        service = await _load_owned_service(user_id, request.code)
        if not service:
            return WebAppRenewPlansResponse(ok=False, error="سرویس یافت نشد یا قابل تمدید نیست")

        panel = await PanelsManager().get_panel_by_code(request.panel_code)
        if not panel or not getattr(panel, "enable", False):
            return WebAppRenewPlansResponse(ok=False, error="پنل یافت نشد یا غیرفعال است")

        durations = await PlanManager().get_unique_durations(request.panel_code)
        plans = await PlanManager().get_all_plans(panel_code=request.panel_code, duration=request.duration)

        # fair_usage را بر اساس پلن فعلی سرویس (نه پنل انتخابی) فیلتر کن
        is_fair = await _service_is_fair_usage(service, int(service.in_panel))
        filtered = _filter_plans_for_service(plans, is_fair)
        filtered = sorted(filtered, key=lambda p: (int(p.duration), float(p.storage), int(p.price)))

        if not filtered:
            return WebAppRenewPlansResponse(ok=False, error="هیچ پلنی برای تمدید در این پنل یافت نشد")

        return WebAppRenewPlansResponse(
            ok=True,
            panel=RenewPanelItem(
                code=int(panel.code),
                name=panel.name,
                display_mode=panel_display_mode(panel),
                durations=[int(d) for d in durations],
            ),
            durations=[int(d) for d in durations],
            plans=[_plan_item(p) for p in filtered],
            is_fair_usage=is_fair,
        )
    except ValueError as e:
        return WebAppRenewPlansResponse(ok=False, error=str(e))
    except Exception as e:
        logger.exception("renew plans failed: %s", e)
        return WebAppRenewPlansResponse(ok=False, error=str(e))


@router.post("/webapp/renew/confirm", response_model=WebAppRenewConfirmResponse)
async def confirm_renew(request: WebAppRenewConfirmRequest) -> WebAppRenewConfirmResponse:
    async with renew_confirm_locks[int(request.code)]:
        return await _confirm_renew_locked(request)


async def _confirm_renew_locked(request: WebAppRenewConfirmRequest) -> WebAppRenewConfirmResponse:
    try:
        user_id = await authenticate_user(init_data=request.init_data, session_token=request.session_token)
        service = await _load_owned_service(user_id, request.code)
        if not service:
            return WebAppRenewConfirmResponse(ok=False, error="سرویس یافت نشد یا قابل تمدید نیست")

        plan = await PlanManager().get_plan(request.plan_id)
        if not plan or int(plan.panel_code) != int(request.panel_code):
            return WebAppRenewConfirmResponse(ok=False, error="پلن یافت نشد")

        selected_panel = await PanelsManager().get_panel_by_code(request.panel_code)
        if not selected_panel:
            return WebAppRenewConfirmResponse(ok=False, error="پنل یافت نشد")

        # سرویس روی پنل فعلی است؛ برای خواندن یوزر از پنل فعلی استفاده می‌کنیم
        # (چون base_url یکی است معمولاً همان یوزر است)
        current_panel = await PanelsManager().get_panel_by_code(service.in_panel)
        if not current_panel:
            return WebAppRenewConfirmResponse(ok=False, error="پنل سرویس یافت نشد")

        price = int(plan.price)
        if request.discount_code and request.discount_code.strip():
            status, res = await DiscountCodeManager().validate_discount_code(
                code=request.discount_code.strip(), user_id=user_id
            )
            if not status:
                return WebAppRenewConfirmResponse(ok=False, error=str(res) if res else "کد تخفیف نامعتبر است")
            if status and res and hasattr(res, "discount_percentage"):
                pct = int(res.discount_percentage or 0)
                price = max(0, int(plan.price) - (int(plan.price) * pct // 100))

        user = await UserCRUD().read_user(user_id)
        balance = int(user.amount or 0) if user else 0
        if balance < price:
            return WebAppRenewConfirmResponse(
                ok=False,
                error="موجودی کیف پول کافی نیست. لطفاً ابتدا موجودی خود را افزایش دهید.",
            )

        api = PasarguardAPI(current_panel.base_url)
        try:
            panel_user = await api.get_user_by_id(
                user_id=require_panel_userid(service),
                token=current_panel.cookie,
            )
        except Exception:
            return WebAppRenewConfirmResponse(ok=False, error="خطا در ارتباط با پنل")

        # اگر پنل عوض شده → group_ids پنل انتخابی را روی یوزر بگذار
        group_ids: list[int] | None = None
        if int(request.panel_code) != int(service.in_panel):
            try:
                groups_resp = await api.get_all_groups(selected_panel.cookie)
                group_ids = resolve_group_ids(selected_panel, groups_resp)
            except Exception:
                logger.exception("failed to resolve groups for panel=%s", request.panel_code)
                return WebAppRenewConfirmResponse(ok=False, error="خطا در دریافت گروه‌های پنل")

        try:
            new_hajm, new_balance = await execute_paid_service_renewal(
                service,
                current_panel,
                plan,
                price=price,
                panel_user=panel_user,
                group_ids=group_ids,
                new_panel_code=int(request.panel_code) if int(request.panel_code) != int(service.in_panel) else None,
                panel_cookie_for_modify=selected_panel.cookie if group_ids is not None else None,
            )
        except PaidRenewalError as exc:
            return WebAppRenewConfirmResponse(ok=False, error=str(exc))
        except Exception:
            logger.exception("renew panel/db failed for service=%s", request.code)
            return WebAppRenewConfirmResponse(
                ok=False,
                error="خطا در اعمال تمدید روی پنل. موجودی به کیف پول بازگردانده شد.",
            )

        if request.discount_code and request.discount_code.strip():
            await DiscountCodeManager().update_discount_usage(request.discount_code.strip())

        await enqueue(
            message=(
                f"📢 **تمدید سرویس (وب‌اپ)**\n\n"
                f"👤 شناسه کاربر: `{user_id}`\n"
                f"📅 تاریخ تمدید (میلادی): `{Time_Date()['mf']}`\n"
                f"📅 تاریخ تمدید (شمسی): `{Time_Date()['jf']}`\n"
                f"🎫 کد سرویس: `{request.code}`\n"
                f"**🔷 اسم کانفیگ:** `{service.username}`\n"
                f"**🖥 پنل:** `{selected_panel.name}`\n"
                f"**📥 حجم جدید کانفیگ:** `{format_size(new_hajm, decimal_places=2)}`\n"
                f"💸 مبلغ پرداخت شده: `{price:,}` تومان\n"
                f"💵 موجودی جدید کاربر: `{new_balance:,}` تومان"
            ),
            log_type=LogType.OTHER,
        )

        return WebAppRenewConfirmResponse(
            ok=True,
            message="سرویس با موفقیت تمدید شد",
            new_balance=new_balance,
            new_volume_bytes=int(new_hajm),
            amount_paid=price,
            config_name=service.username,
            panel_name=selected_panel.name,
        )
    except ValueError as e:
        return WebAppRenewConfirmResponse(ok=False, error=str(e))
    except Exception as e:
        logger.exception("renew confirm failed for service=%s: %s", request.code, e)
        return WebAppRenewConfirmResponse(ok=False, error="خطا در تمدید سرویس")