import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { EmojiIcon } from "../../components/EmojiIcon";
import { PageHeader } from "../../components/layout/PageHeader";
import { Button, Card, Input, Stepper } from "../../components/ui";
import { ErrorState } from "../../components/ui/EmptyState";
import { useTelegram } from "../../hooks/useTelegram";
import { useWebAppAuth } from "../../hooks/useWebAppAuth";
import { formatBytes, formatIpLimit, formatNumber, formatToman } from "../../lib/format";
import { formatPlanLabel } from "../../lib/serviceHelpers";
import { renewApi } from "../../api/webapp";
import {
  useRenewConfirmMutation,
  useRenewOptionsQuery,
  useRenewPlansQuery,
} from "../../queries/useServices";
import type { RenewPanelItem, RenewPlanItem } from "../../types/webapp";

type RenewStep = "panel" | "duration" | "plan" | "confirm" | "success";

function InfoRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className={strong ? "font-semibold text-primary" : "text-text"}>{value}</span>
    </div>
  );
}

function PanelSummary({ panel, duration }: { panel: RenewPanelItem | null; duration?: number | null }) {
  const { t } = useTranslation();
  if (!panel) return null;
  return (
    <Card className="p-4">
      <p className="text-xs text-muted">{t("buy.selectedPanel")}</p>
      <p className="mt-1 text-lg font-black text-text">{panel.name}</p>
      {duration != null && <p className="mt-1 text-sm text-muted">{t("renewFlow.days", { count: duration })}</p>}
    </Card>
  );
}

export default function RenewFlow() {
  const { t } = useTranslation();
  const { code: codeParam } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { haptic } = useTelegram();
  const { auth } = useWebAppAuth();
  const queryClient = useQueryClient();

  const code = codeParam ? Number(codeParam) : null;
  const { data: options, isLoading, error, refetch } = useRenewOptionsQuery(code);
  const confirmRenew = useRenewConfirmMutation();

  const [step, setStep] = useState<RenewStep>("panel");
  const [selectedPanel, setSelectedPanel] = useState<RenewPanelItem | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<number | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<RenewPlanItem | null>(null);
  const [discountCode, setDiscountCode] = useState("");
  const [submitError, setSubmitError] = useState("");

  const { data: plansResponse, isLoading: plansLoading } = useRenewPlansQuery(
    code,
    selectedPanel?.code ?? null,
    selectedDuration
  );

  const stepLabels = [
    t("buy.stepPanel"),
    t("buy.stepDuration"),
    t("buy.stepPlan"),
    t("buy.stepConfirm"),
    t("renewFlow.renewSuccess"),
  ];

  const stepIndex = useMemo(() => {
    const order: RenewStep[] = ["panel", "duration", "plan", "confirm", "success"];
    return order.indexOf(step);
  }, [step]);

  const plansForStep = useMemo(() => {
    const plans = plansResponse?.plans ?? [];
    if (selectedDuration == null) return plans;
    return plans.filter((p) => p.duration === selectedDuration);
  }, [plansResponse?.plans, selectedDuration]);

  const backTo = code != null ? `/services/${code}` : "/services";

  // اگر فقط یک پنل بود، خودکار انتخاب کن
  useEffect(() => {
    if (!options?.ok || !options.panels?.length || selectedPanel) return;
    if (options.panels.length === 1) {
      void selectPanel(options.panels[0]!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.ok, options?.panels]);

  const selectPanel = async (panel: RenewPanelItem) => {
    if (!auth || code == null) return;
    haptic.select();
    setSelectedPanel(panel);
    setSelectedDuration(null);
    setSelectedPlan(null);
    setSubmitError("");

    const plansData = await queryClient.fetchQuery({
      queryKey: ["renew-plans", code, panel.code, null, auth.session_token, auth.init_data],
      queryFn: () =>
        renewApi.getRenewPlans({
          ...auth,
          code,
          panel_code: panel.code,
          duration: null,
        }),
    });

    const displayMode = panel.display_mode || plansData.panel?.display_mode;
    const hasDurationStep = displayMode === "duration_first" && (plansData.durations?.length ?? 0) > 1;
    setStep(hasDurationStep ? "duration" : "plan");
  };

  const selectDuration = async (duration: number) => {
    if (!auth || !selectedPanel || code == null) return;
    haptic.select();
    setSelectedDuration(duration);
    setSelectedPlan(null);
    await queryClient.fetchQuery({
      queryKey: ["renew-plans", code, selectedPanel.code, duration, auth.session_token, auth.init_data],
      queryFn: () =>
        renewApi.getRenewPlans({
          ...auth,
          code,
          panel_code: selectedPanel.code,
          duration,
        }),
    });
    setStep("plan");
  };

  const handleConfirm = () => {
    if (!selectedPlan || !selectedPanel || code == null) return;
    haptic.impact("medium");
    setSubmitError("");
    confirmRenew.mutate(
      {
        code,
        panelCode: selectedPanel.code,
        planId: selectedPlan.id,
        discountCode,
      },
      {
        onSuccess: (res) => {
          if (res.ok === false) {
            setSubmitError(res.error || t("renewFlow.noPlans"));
            return;
          }
          haptic.notify("success");
          setStep("success");
        },
        onError: (err) => setSubmitError((err as Error).message),
      }
    );
  };

  if (code == null || Number.isNaN(code)) {
    return (
      <div>
        <PageHeader title={t("renewFlow.title")} back="/services" />
        <ErrorState message={t("renewFlow.invalidCode")} />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div>
        <PageHeader title={t("renewFlow.title")} back={backTo} />
        <Card className="h-32 animate-pulse bg-surface-2" />
      </div>
    );
  }

  if (error || !options?.ok) {
    return (
      <div>
        <PageHeader title={t("renewFlow.title")} back={backTo} />
        <ErrorState
          message={(error as Error)?.message || options?.error || t("renewFlow.noPlans")}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const panels = options.panels ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("renewFlow.title")}
        subtitle={options.current_panel_name ?? undefined}
        back={backTo}
      />

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between text-sm">
          <span className="text-muted">{t("buy.step")}</span>
          <span className="font-bold text-primary">{stepLabels[stepIndex]}</span>
        </div>
        <Stepper steps={stepLabels} current={stepIndex} />
      </Card>

      {submitError && <ErrorState message={submitError} />}

      <AnimatePresence mode="wait">
        {step === "panel" && (
          <motion.section
            key="panel"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-3"
          >
            {panels.map((panel) => (
              <button
                key={panel.code}
                type="button"
                onClick={() => void selectPanel(panel)}
                className="group w-full overflow-hidden rounded-lg border border-border bg-surface p-4 text-right shadow-sm transition hover:-translate-y-0.5 hover:border-primary/50"
              >
                <div className="flex items-center gap-4">
                  <div className="rounded-md bg-primary/10 p-3 text-primary ring-1 ring-primary/20">
                    <EmojiIcon id="globe_with_meridians" size={26} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-text">{panel.name}</p>
                    <p className="mt-1 text-xs text-muted">
                      {panel.display_mode === "duration_first"
                        ? t("buy.durationFirstDesc")
                        : t("buy.quickSelectDesc")}
                      {options.current_panel_code === panel.code ? " · فعلی" : ""}
                    </p>
                  </div>
                  <span className="rounded-full bg-surface-2 px-3 py-1 text-xs text-primary ring-1 ring-border transition group-hover:bg-primary/15">
                    {t("buy.select")}
                  </span>
                </div>
              </button>
            ))}
          </motion.section>
        )}

        {step === "duration" && (
          <motion.section
            key="duration"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-4"
          >
            <Button type="button" variant="ghost" size="sm" onClick={() => setStep("panel")}>
              {t("buy.back")}
            </Button>
            <PanelSummary panel={selectedPanel} />
            <p className="text-sm text-muted">{t("buy.selectDuration")}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(plansResponse?.durations ?? selectedPanel?.durations ?? []).map((duration) => (
                <button
                  key={duration}
                  type="button"
                  onClick={() => void selectDuration(duration)}
                  className="rounded-lg border border-border bg-surface p-4 text-center shadow-sm transition hover:border-primary/50 hover:bg-primary/10"
                >
                  <span className="block text-2xl font-black text-primary">{duration}</span>
                  <span className="text-xs text-muted">{t("buy.subscriptionDays")}</span>
                </button>
              ))}
            </div>
          </motion.section>
        )}

        {step === "plan" && (
          <motion.section
            key="plan"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-4"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setStep(selectedPanel?.display_mode === "duration_first" ? "duration" : "panel")
              }
            >
              {t("buy.back")}
            </Button>
            <PanelSummary panel={selectedPanel} duration={selectedDuration} />
            {plansLoading ? (
              <Card className="h-24 animate-pulse bg-surface-2" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {plansForStep.map((plan) => (
                  <button
                    key={plan.id}
                    type="button"
                    onClick={() => {
                      haptic.select();
                      setSelectedPlan(plan);
                      setStep("confirm");
                    }}
                    className="group w-full overflow-hidden rounded-lg border border-border bg-surface p-4 text-right shadow-sm transition hover:-translate-y-0.5 hover:border-primary/50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-lg font-black text-text">
                          {formatPlanLabel(plan.storage, plan.plan_type, plan.data_limit_reset_strategy, true)}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {t("renewFlow.days", { count: plan.duration })} • {formatIpLimit(plan.ip_limit)}
                        </p>
                      </div>
                      <span className="rounded-md bg-primary/10 px-3 py-2 text-sm font-bold text-primary ring-1 ring-primary/20">
                        {formatNumber(plan.price)}
                      </span>
                    </div>
                    <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full w-2/3 rounded-full bg-primary transition group-hover:w-full" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </motion.section>
        )}

        {step === "confirm" && selectedPlan && selectedPanel && (
          <motion.section
            key="confirm"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-4"
          >
            <Button type="button" variant="ghost" size="sm" onClick={() => setStep("plan")}>
              {t("buy.back")}
            </Button>
            <Card className="space-y-3 border-primary/20 p-4">
              <InfoRow label={t("buy.panel")} value={selectedPanel.name} />
              <InfoRow
                label={t("buy.stepPlan")}
                value={formatPlanLabel(
                  selectedPlan.storage,
                  selectedPlan.plan_type,
                  selectedPlan.data_limit_reset_strategy,
                  true
                )}
              />
              <InfoRow label={t("buy.duration")} value={t("renewFlow.days", { count: selectedPlan.duration })} />
              <Card className="bg-primary/10 p-3 ring-1 ring-primary/20">
                <InfoRow label={t("buy.finalPrice")} value={formatToman(selectedPlan.price)} strong />
              </Card>
            </Card>
            <Input
              label={t("renewFlow.discountCode")}
              value={discountCode}
              onChange={(e) => setDiscountCode(e.target.value)}
              placeholder={t("renewFlow.discountCodePlaceholder")}
              ltr
              disabled={confirmRenew.isPending}
            />
            <Button type="button" fullWidth loading={confirmRenew.isPending} onClick={handleConfirm}>
              {t("renewFlow.confirmAndRenew")}
            </Button>
          </motion.section>
        )}

        {step === "success" && (
          <motion.section
            key="success"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            className="space-y-4"
          >
            <Card className="space-y-2 border-success/30 bg-success/5 p-4">
              <p className="font-semibold text-success">
                {confirmRenew.data?.message ?? t("renewFlow.renewSuccess")}
              </p>
              {confirmRenew.data?.panel_name && (
                <p className="text-sm text-text">
                  {t("buy.panel")}: <span className="font-semibold">{confirmRenew.data.panel_name}</span>
                </p>
              )}
              {confirmRenew.data?.new_volume_bytes != null && (
                <p className="text-sm text-text">
                  {t("renewFlow.newVolume")}:{" "}
                  <span className="font-semibold">{formatBytes(confirmRenew.data.new_volume_bytes)}</span>
                </p>
              )}
              {confirmRenew.data?.amount_paid != null && (
                <p className="text-sm text-text">
                  {t("renewFlow.amountPaid")}:{" "}
                  <span className="font-semibold">{formatToman(confirmRenew.data.amount_paid)}</span>
                </p>
              )}
              {confirmRenew.data?.new_balance != null && (
                <p className="text-sm text-text">
                  {t("renewFlow.newBalance")}:{" "}
                  <span className="font-semibold">{formatToman(confirmRenew.data.new_balance)}</span>
                </p>
              )}
            </Card>
            <Button type="button" fullWidth onClick={() => navigate(backTo)}>
              {t("renewFlow.backToService")}
            </Button>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}