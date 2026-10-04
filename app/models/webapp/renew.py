"""WebApp DTOs: manual renewal options and confirmation."""

from pydantic import BaseModel, Field

from app.models.webapp.common import WebAppAuthRequest


class RenewPanelItem(BaseModel):
    code: int
    name: str
    display_mode: str = "classic"
    durations: list[int] = Field(default_factory=list)


class RenewPlanItem(BaseModel):
    id: int
    storage: float
    duration: int
    price: int
    plan_type: str = "volume"
    data_limit_reset_strategy: str = "no_reset"
    ip_limit: int = 0


class WebAppRenewOptionsRequest(WebAppAuthRequest):
    code: int = Field(..., description="Service code")


class WebAppRenewOptionsResponse(BaseModel):
    ok: bool
    service_code: str | None = None
    current_panel_code: int | None = None
    current_panel_name: str | None = None
    is_fair_usage: bool = False
    panels: list[RenewPanelItem] = Field(default_factory=list)
    error: str | None = None


class WebAppRenewPlansRequest(WebAppAuthRequest):
    code: int = Field(..., description="Service code")
    panel_code: int = Field(..., description="Selected panel code")
    duration: int | None = Field(None, description="Optional selected duration")


class WebAppRenewPlansResponse(BaseModel):
    ok: bool
    panel: RenewPanelItem | None = None
    durations: list[int] = Field(default_factory=list)
    plans: list[RenewPlanItem] = Field(default_factory=list)
    is_fair_usage: bool = False
    error: str | None = None


class WebAppRenewConfirmRequest(WebAppAuthRequest):
    code: int = Field(..., description="Service code")
    panel_code: int = Field(..., description="Selected panel code")
    plan_id: int = Field(..., description="Selected plan id")
    discount_code: str | None = Field(None, description="Optional discount code")


class WebAppRenewConfirmResponse(BaseModel):
    ok: bool
    message: str | None = None
    new_balance: int | None = None
    new_volume_bytes: int | None = None
    amount_paid: int | None = None
    config_name: str | None = None
    panel_name: str | None = None
    error: str | None = None