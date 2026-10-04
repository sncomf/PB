import type {
  WebAppRenewConfirmRequest,
  WebAppRenewConfirmResponse,
  WebAppRenewOptionsRequest,
  WebAppRenewOptionsResponse,
  WebAppRenewPlansRequest,
  WebAppRenewPlansResponse,
} from "../../types/webapp";
import { apiPost } from "./client";

export function getRenewOptions(body: WebAppRenewOptionsRequest) {
  return apiPost<WebAppRenewOptionsResponse>("/renew/options", body);
}

export function getRenewPlans(body: WebAppRenewPlansRequest) {
  return apiPost<WebAppRenewPlansResponse>("/renew/plans", body);
}

export function confirmRenew(body: WebAppRenewConfirmRequest) {
  return apiPost<WebAppRenewConfirmResponse>("/renew/confirm", body);
}