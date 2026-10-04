/** Mirrors app/models/webapp/renew.py */
import type { WebAppAuthRequest } from "./common";

export interface RenewPanelItem {
  code: number;
  name: string;
  display_mode: string;
  durations: number[];
}

export interface RenewPlanItem {
  id: number;
  storage: number;
  duration: number;
  price: number;
  plan_type: string;
  data_limit_reset_strategy: string;
  ip_limit: number;
}

export interface WebAppRenewOptionsRequest extends WebAppAuthRequest {
  code: number;
}

export interface WebAppRenewOptionsResponse {
  ok: boolean;
  service_code?: string | null;
  current_panel_code?: number | null;
  current_panel_name?: string | null;
  is_fair_usage: boolean;
  panels: RenewPanelItem[];
  error?: string | null;
}

export interface WebAppRenewPlansRequest extends WebAppAuthRequest {
  code: number;
  panel_code: number;
  duration?: number | null;
}

export interface WebAppRenewPlansResponse {
  ok: boolean;
  panel?: RenewPanelItem | null;
  durations: number[];
  plans: RenewPlanItem[];
  is_fair_usage: boolean;
  error?: string | null;
}

export interface WebAppRenewConfirmRequest extends WebAppAuthRequest {
  code: number;
  panel_code: number;
  plan_id: number;
  discount_code?: string | null;
}

export interface WebAppRenewConfirmResponse {
  ok: boolean;
  message?: string | null;
  new_balance?: number | null;
  new_volume_bytes?: number | null;
  amount_paid?: number | null;
  config_name?: string | null;
  panel_name?: string | null;
  error?: string | null;
}