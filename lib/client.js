/**
 * dsh-system-monitor — browser half.
 *
 * Registers the right-sidebar "System" tab:
 *   1. `ctx.sidebarRightTabs.register(...)` declares the page kind (no
 *      patterns: it is a page, opened by kind).
 *   2. `ctx.slots.register({ name: "sidebar.right.pane.tab", key: <same id> })`
 *      binds the body that renders inside the tab.
 *   3. `ctx.slots.inject("sidebar.right.pane.tab.title", ...)` supplies the chip
 *      label, and the `guide` entry makes the tab discoverable from the guide
 *      page's entry list.
 *
 * The panel polls the host half's loopback route once per second and draws
 * nvtop/htop-style meters with app theme variables. It is authored as a plain
 * prebuilt bundle (`window.__ModuleLoader__.load`), exactly like the shipped
 * client bundles, so the package needs no build step:
 *
 *   - `require` resolves the shell's frozen module table (react,
 *     react/jsx-runtime, @deepseek-ai/dsh-client-ui-primitives), plus whatever
 *     `dsh.client.inject` names.
 *   - `react.createElement` is used instead of JSX to keep the file valid
 *     JavaScript as-is.
 *
 * Everything degrades gracefully: no GPU / no hwmon / older host simply means
 * the corresponding section shows a hint instead of breaking the panel.
 */

window.__ModuleLoader__.load({
  id: "dsh-system-monitor",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    /** Stable ids: the tab type registry, the slot key and the chip all agree. */
    const TYPE_ID = "dsh-system-monitor/system";
    const TAB_KIND = "system-monitor";
    const NS = "dsh-system-monitor";

    /**
     * Client context captured in `apply`, for handlers outside the effect scope
     * (the sidebar chip's click). Failures are NOT swallowed: every distinct
     * step that can go wrong gets its own message, it is logged to the console,
     * and the chip surfaces it — a silently dead click is undebuggable.
     */
    let pluginCtx = null;
    function openSystemTab() {
      if (pluginCtx === null) {
        return { ok: false, error: "插件上下文未捕获（bundle 未执行 apply）" };
      }
      const controller = pluginCtx.sidebarRight;
      if (controller === void 0 || controller === null) {
        return { ok: false, error: "ctx.sidebarRight 不可用（右侧栏服务未注入）" };
      }
      const attempt = () => {
        try {
          controller.openTab(TAB_KIND);
          return { ok: true, error: null };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          pluginCtx.logger?.warn?.(`[${NS}] openTab(${TAB_KIND}) failed: ${message}`);
          return { ok: false, error: message };
        }
      };
      const first = attempt();
      if (first.ok) return { ok: true, error: null };
      // `openTab` needs a mounted session surface. If the right sidebar was never
      // opened in this view, expand it first (the frame's layout service) and
      // retry once on the next tick, so a click from the always-visible chip
      // works even before the user has ever opened the right column.
      const layout = pluginCtx.layout;
      if (layout !== void 0 && layout !== null && typeof layout.openRightbar === "function") {
        try {
          layout.openRightbar(false, false);
          setTimeout(() => {
            const retry = attempt();
            if (!retry.ok) pluginCtx.logger?.warn?.(`[${NS}] retry after openRightbar failed: ${retry.error}`);
          }, 0);
          return { ok: true, error: null, deferred: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          pluginCtx.logger?.warn?.(`[${NS}] openRightbar failed: ${message}`);
          return { ok: false, error: `展开右侧栏失败：${message}` };
        }
      }
      return { ok: false, error: `openTab 失败：${first.error}` };
    }

    /** Host route registered by the node half (same path spelled there). */
    const SNAPSHOT_URL = "/api/dsh-system-monitor/snapshot";
    /** Panel poll cadence; the host additionally rate-limits its own sampling. */
    const POLL_MS = 1000;
    /** Chip poll cadence: an idle GUI should not be woken every second. */
    const CHIP_POLL_MS = 3000;

    /* ---------------------------------------------------------------- *
     * formatting helpers
     * ---------------------------------------------------------------- */

    function clampPercent(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      return Math.max(0, Math.min(100, value));
    }

    function formatBytes(bytes) {
      if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
      const units = ["B", "KiB", "MiB", "GiB", "TiB"];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
    }

    function formatPercent(value, digits = 0) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      return `${value.toFixed(digits)}%`;
    }

    function formatNumber(value, digits = 0) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      return value.toFixed(digits);
    }

    /** Utilisation → theme colour step: normal / warn / hot. */
    function levelOf(percent) {
      const value = clampPercent(percent);
      if (value === null) return 0;
      if (value >= 90) return 2;
      if (value >= 75) return 1;
      return 0;
    }

    const LEVEL_COLOR = [
      "var(--dsw-alias-state-business-primary, #4176e6)",
      "var(--dsw-alias-state-warn-primary, #f59e0b)",
      "var(--dsw-alias-state-error-primary, #f25a5a)"
    ];

    function formatUptime(seconds) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${minutes}m`;
      return `${minutes}m`;
    }

    /** Compact whole-number percentage for dense cell labels. */
    function percentText(value) {
      const percent = clampPercent(value);
      return percent === null ? "—" : `${Math.round(percent)}%`;
    }

    /* ---------------------------------------------------------------- *
     * design tokens
     * ---------------------------------------------------------------- */

    const T = {
      text: "var(--dsw-alias-label-primary, #0f1115)",
      sub: "var(--dsw-alias-label-secondary, #61666b)",
      faint: "var(--dsw-alias-label-caption, #adb2b8)",
      line: "var(--dsw-alias-border-l2, rgba(0, 0, 0, .1))",
      card: "var(--dsw-specific-sidebar-fill, #f9fafb)",
      base: "var(--dsw-alias-bg-base, #fff)",
      green: "var(--dsw-alias-state-success-primary, #22c55e)",
      amber: "var(--dsw-alias-state-warn-primary, #f59e0b)"
    };

    /** A translucent wash of `color`; degrades to "no paint" on old Chromium. */
    function tint(color, percent) {
      return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
    }

    const TRACK = `color-mix(in srgb, ${T.text} 8%, transparent)`;
    const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

    /* ---------------------------------------------------------------- *
     * primitives
     * ---------------------------------------------------------------- */

    const S = {
      root: {
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        padding: "14px 16px 22px",
        fontSize: "12px",
        lineHeight: "18px",
        color: T.text,
        overflowY: "auto",
        height: "100%",
        boxSizing: "border-box"
      },
      header: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "10px"
      },
      title: { fontSize: "13px", fontWeight: 600, letterSpacing: "-0.01em", lineHeight: "18px" },
      subtitle: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        marginTop: "3px",
        fontSize: "11px",
        lineHeight: "16px",
        color: T.faint
      },
      liveDot: {
        width: "6px",
        height: "6px",
        borderRadius: "50%",
        background: T.green,
        boxShadow: `0 0 0 3px ${tint(T.green, 14)}`,
        flex: "0 0 auto"
      },
      actions: { display: "flex", gap: "6px", flex: "0 0 auto" },
      button: {
        height: "24px",
        padding: "0 9px",
        borderRadius: "7px",
        border: `1px solid ${T.line}`,
        background: T.base,
        color: T.sub,
        cursor: "pointer",
        font: "inherit",
        fontSize: "11px",
        lineHeight: "22px"
      },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "12px 14px",
        borderRadius: "12px",
        border: `1px solid ${T.line}`,
        background: T.card
      },
      cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" },
      cardTitle: { fontSize: "11px", fontWeight: 600, letterSpacing: ".06em", color: T.sub },
      cardAside: {
        fontSize: "11px",
        color: T.faint,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "62%"
      },
      hero: {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "12px 14px 10px",
        borderRadius: "12px",
        border: `1px solid ${tint(LEVEL_COLOR[0], 22)}`,
        background: T.card,
        backgroundImage: `linear-gradient(180deg, ${tint(LEVEL_COLOR[0], 7)}, transparent 78%)`
      },
      heroGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "12px" },
      heroLabel: { fontSize: "10px", fontWeight: 600, letterSpacing: ".08em", color: T.faint },
      heroValue: {
        marginTop: "1px",
        fontSize: "21px",
        lineHeight: "26px",
        fontWeight: 600,
        letterSpacing: "-0.02em",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap"
      },
      heroUnit: { marginLeft: "1px", fontSize: "11px", fontWeight: 500, color: T.faint },
      tile: {
        position: "relative",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        gap: "4px",
        minWidth: 0,
        padding: "7px 9px 4px",
        borderRadius: "9px",
        border: `1px solid ${tint(T.text, 6)}`,
        background: T.base
      },
      tileTop: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "6px" },
      tileLabel: { fontSize: "10px", fontWeight: 600, letterSpacing: ".08em", color: T.faint },
      tileValue: {
        fontSize: "20px",
        lineHeight: "25px",
        fontWeight: 600,
        letterSpacing: "-0.02em",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap"
      },
      axis: {
        display: "flex",
        justifyContent: "space-between",
        gap: "4px",
        marginTop: "2px",
        fontSize: "10px",
        lineHeight: "13px",
        color: T.faint,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap"
      },
      delta: {
        marginTop: "1px",
        fontSize: "10px",
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap"
      },
      statePill: {
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "1px 8px",
        borderRadius: "999px",
        fontSize: "10px",
        fontWeight: 600,
        lineHeight: "16px"
      },
      tick: { position: "absolute", top: 0, bottom: 0, width: "1px", background: tint(T.text, 22), zIndex: 1 },
      row: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px" },
      label: { color: T.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
      value: { fontVariantNumeric: "tabular-nums", fontWeight: 600, whiteSpace: "nowrap" },
      detail: { marginLeft: "6px", fontWeight: 400, color: T.faint, fontSize: "11px" },
      track: {
        position: "relative",
        height: "8px",
        borderRadius: "999px",
        background: TRACK,
        overflow: "hidden"
      },
      fill: {
        position: "absolute",
        inset: "0 auto 0 0",
        borderRadius: "999px",
        transition: "width .45s cubic-bezier(.4, 0, .2, 1)"
      },
      pills: { display: "flex", flexWrap: "wrap", gap: "6px" },
      pill: {
        display: "inline-flex",
        alignItems: "baseline",
        gap: "4px",
        padding: "2px 8px",
        borderRadius: "999px",
        background: tint(T.text, 5),
        fontSize: "11px",
        lineHeight: "16px",
        color: T.faint,
        whiteSpace: "nowrap"
      },
      pillValue: { color: T.sub, fontWeight: 600, fontVariantNumeric: "tabular-nums" },
      coreGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))", gap: "9px 12px" },
      coreTop: {
        display: "flex",
        justifyContent: "space-between",
        gap: "6px",
        fontSize: "10px",
        lineHeight: "14px",
        color: T.faint,
        fontVariantNumeric: "tabular-nums"
      },
      coreTrack: { marginTop: "3px", height: "3px", borderRadius: "999px", background: TRACK, overflow: "hidden" },
      hint: { color: T.faint, fontSize: "11px", lineHeight: "16px" },
      error: {
        padding: "8px 10px",
        borderRadius: "8px",
        background: tint(LEVEL_COLOR[2], 8),
        color: LEVEL_COLOR[2],
        fontSize: "11px",
        lineHeight: "16px",
        wordBreak: "break-word"
      },
      panelTitleChip: { display: "inline-flex", alignItems: "center", gap: "6px" },
      chip: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        margin: "0 8px 4px",
        padding: "6px 9px",
        border: `1px solid ${T.line}`,
        borderRadius: "9px",
        background: T.card,
        color: T.text,
        cursor: "pointer",
        font: "inherit",
        fontSize: "11px",
        lineHeight: "16px",
        textAlign: "left"
      },
      chipCell: { display: "inline-flex", alignItems: "baseline", gap: "3px" },
      chipLabel: { color: T.faint, fontSize: "10px", letterSpacing: ".04em" },
      chipValue: { fontVariantNumeric: "tabular-nums", fontWeight: 600 }
    };

    function Meter(props) {
      const percent = clampPercent(props.percent);
      const level = levelOf(percent);
      const color = props.color ?? LEVEL_COLOR[level];
      const value = percent === null ? 0 : percent;
      return h(
        "div",
        {
          style: { ...S.track, height: `${props.height ?? 8}px` },
          title: percent === null ? "无数据" : `${percent.toFixed(1)}%`
        },
        h("div", {
          style: {
            ...S.fill,
            width: `${value}%`,
            background: `linear-gradient(90deg, ${tint(color, 62)} 0%, ${color} 100%)`
          }
        }),
        h("span", { style: { ...S.tick, left: "75%" } }),
        h("span", { style: { ...S.tick, left: "90%" } })
      );
    }

    function StatRow(props) {
      return h(
        "div",
        { style: S.row },
        h("span", { style: S.label }, props.label),
        h(
          "span",
          { style: { ...S.value, color: props.color } },
          props.value,
          props.detail === void 0 ? null : h("span", { style: S.detail }, props.detail)
        )
      );
    }

    function Pill(props) {
      return h(
        "span",
        { style: S.pill, title: props.title },
        props.label === void 0 ? null : h("span", null, props.label),
        props.value === void 0 ? null : h("span", { style: { ...S.pillValue, color: props.color } }, props.value)
      );
    }

    /** Human time span for the sparkline axis ("3m", "45s"). */
    function formatSpan(samples) {
      if (!Number.isFinite(samples) || samples <= 1) return "";
      const minutes = Math.round(samples / 60);
      return minutes >= 1 ? `${minutes}m` : `${Math.round(samples)}s`;
    }

    /** Keep one maximum per bucket: dense histories lose points, never peaks. */
    function bucketMax(points, target) {
      if (points.length <= target) return points.slice();
      const bucket = points.length / target;
      const out = [];
      for (let index = 0; index < target; index += 1) {
        const start = Math.floor(index * bucket);
        const end = Math.min(points.length, Math.max(start + 1, Math.floor((index + 1) * bucket)));
        let peak = -Infinity;
        for (let cursor = start; cursor < end; cursor += 1) if (points[cursor] > peak) peak = points[cursor];
        out.push(peak === -Infinity ? 0 : peak);
      }
      return out;
    }

    /** Quadratic midpoint smoothing: rounds corners without overshooting peaks. */
    function smoothPath(coords) {
      if (coords.length === 1) return `M${coords[0].x.toFixed(2)},${coords[0].y.toFixed(2)}`;
      let path = `M${coords[0].x.toFixed(2)},${coords[0].y.toFixed(2)}`;
      for (let index = 1; index < coords.length - 1; index += 1) {
        const control = coords[index];
        const next = coords[index + 1];
        path += ` Q${control.x.toFixed(2)},${control.y.toFixed(2)} ${((control.x + next.x) / 2).toFixed(2)},${((control.y + next.y) / 2).toFixed(2)}`;
      }
      const last = coords[coords.length - 1];
      return `${path} L${last.x.toFixed(2)},${last.y.toFixed(2)}`;
    }

    /**
     * Sparkline built from the host's history ring (no chart dependency).
     * The path is drawn in a 0–100 box and stretched by the SVG viewport, so it
     * follows any panel width without a resize observer. On a wide panel it
     * grows a grid, a peak marker and a time axis; on a narrow one it stays a
     * compact inline trend.
     */
    function Sparkline(props) {
      const raw = (props.points ?? []).filter((value) => typeof value === "number" && Number.isFinite(value));
      const wide = props.wide === true;
      const height = props.height ?? (wide ? 46 : 26);
      const points = bucketMax(raw, wide ? 120 : 60);
      const uid = (react.useId ? react.useId() : String(Math.random())).replace(/[^a-zA-Z0-9_-]/g, "");
      if (points.length < 2) {
        return h(
          "div",
          { style: { ...S.hint, height: `${height}px`, fontSize: "10px", display: "flex", alignItems: "center" } },
          props.empty ?? "采样中…"
        );
      }
      const last = points[points.length - 1];
      const color = props.color ?? LEVEL_COLOR[levelOf(last)];
      const coords = points.map((value, index) => ({
        x: index * (100 / (points.length - 1)),
        y: 100 - Math.max(0, Math.min(100, value))
      }));
      const path = smoothPath(coords);
      const area = `${path} L100,100 L0,100 Z`;
      let peakIndex = 0;
      for (let index = 1; index < points.length; index += 1) if (points[index] > points[peakIndex]) peakIndex = index;
      const peakX = peakIndex * (100 / (points.length - 1));
      const peakValue = Math.round(points[peakIndex]);
      const grid = wide ? [25, 50, 75].map((y) =>
        h("line", {
          key: `g${y}`,
          x1: 0,
          x2: 100,
          y1: y,
          y2: y,
          stroke: T.text,
          strokeOpacity: 0.07,
          strokeWidth: 1,
          vectorEffect: "non-scaling-stroke"
        })
      ) : null;
      return h(
        "div",
        null,
        h(
          "svg",
          {
            viewBox: "0 0 100 100",
            preserveAspectRatio: "none",
            style: { width: "100%", height: `${height}px`, display: "block" }
          },
          grid,
          h(
            "defs",
            null,
            h(
              "linearGradient",
              { id: `sm-${uid}`, x1: "0", y1: "0", x2: "0", y2: "1" },
              h("stop", { offset: "0%", stopColor: color, stopOpacity: "0.18" }),
              h("stop", { offset: "100%", stopColor: color, stopOpacity: "0" })
            )
          ),
          wide ? h("line", {
            x1: peakX,
            x2: peakX,
            y1: 0,
            y2: 100,
            stroke: color,
            strokeOpacity: 0.26,
            strokeWidth: 1,
            vectorEffect: "non-scaling-stroke"
          }) : null,
          h("path", { d: area, fill: `url(#sm-${uid})` }),
          h("path", {
            d: path,
            fill: "none",
            stroke: color,
            strokeWidth: 1.5,
            strokeLinejoin: "round",
            strokeLinecap: "round",
            vectorEffect: "non-scaling-stroke"
          })
        ),
        wide ? h(
          "div",
          { style: S.axis },
          h("span", null, `-${formatSpan(raw.length)}`),
          h("span", null, `峰值 ${peakValue}%`),
          h("span", null, "现在")
        ) : null
      );
    }

    function Section(props) {
      return h(
        "section",
        { style: S.card },
        h(
          "div",
          { style: S.cardHead },
          h("span", { style: S.cardTitle }, props.title),
          props.aside === void 0 ? null : h(
            "span",
            { style: S.cardAside, title: typeof props.aside === "string" ? props.aside : void 0 },
            props.aside
          )
        ),
        props.children
      );
    }

    /* ---------------------------------------------------------------- *
     * sections
     * ---------------------------------------------------------------- */

    function CpuSection(props) {
      const cpu = props.snapshot.cpu ?? {};
      const perCore = Array.isArray(cpu.perCore) ? cpu.perCore : [];
      const frequency = cpu.frequency ?? {};
      const load = cpu.load ?? {};
      const average = frequency.avg === null || frequency.avg === void 0 ? null : formatNumber(frequency.avg);
      const hottestCore = perCore.reduce(
        (best, core) => (typeof core.usage === "number" && core.usage > (best === null ? -1 : best.usage) ? core : best),
        null
      );
      return h(
        Section,
        {
          title: "CPU",
          aside: [
            `${cpu.cores ?? "—"} 核`,
            average === null ? null : `平均 ${average} MHz`,
            hottestCore === null ? null : `峰值 c${hottestCore.core} ${percentText(hottestCore.usage)}`
          ].filter(Boolean).join(" · ")
        },
        h(StatRow, {
          label: "总占用",
          value: formatPercent(cpu.usage, 1),
          color: LEVEL_COLOR[levelOf(cpu.usage)]
        }),
        h(Meter, { percent: cpu.usage }),
        h(
          "div",
          { style: S.coreGrid },
          perCore.map((core) =>
            h(
              "div",
              { key: core.core, title: `core ${core.core}: ${formatPercent(core.usage, 1)}` },
              h(
                "div",
                { style: S.coreTop },
                h(
                  "span",
                  null,
                  core === hottestCore ?
                    h("span", {
                      style: {
                        display: "inline-block",
                        width: "4px",
                        height: "4px",
                        marginRight: "4px",
                        borderRadius: "50%",
                        verticalAlign: "middle",
                        background: LEVEL_COLOR[levelOf(core.usage)]
                      }
                    }) :
                    null,
                  `c${core.core}`
                ),
                h(
                  "span",
                  { style: { color: levelOf(core.usage) === 0 ? T.faint : LEVEL_COLOR[levelOf(core.usage)] } },
                  percentText(core.usage)
                )
              ),
              h(
                "div",
                { style: S.coreTrack },
                h("span", {
                  style: {
                    display: "block",
                    height: "100%",
                    width: `${clampPercent(core.usage) ?? 0}%`,
                    borderRadius: "999px",
                    background: LEVEL_COLOR[levelOf(core.usage)],
                    transition: "width .45s cubic-bezier(.4, 0, .2, 1)"
                  }
                })
              )
            )
          )
        ),
        h(
          "div",
          { style: S.pills },
          h(Pill, {
            label: "负载",
            value: `${formatNumber(load.one, 2)} / ${formatNumber(load.five, 2)} / ${formatNumber(load.fifteen, 2)}`
          }),
          frequency.min === null || frequency.min === void 0 ?
            null :
            h(Pill, { label: "频率", value: `${formatNumber(frequency.min)}–${formatNumber(frequency.max)} MHz` })
        )
      );
    }

    function MemorySection(props) {
      const memory = props.snapshot.memory ?? {};
      const swap = memory.swap ?? {};
      const swapPercent = clampPercent(swap.usedPercent);
      return h(
        Section,
        { title: "内存", aside: formatBytes(memory.total) },
        h(StatRow, {
          label: "已用",
          value: formatPercent(memory.usedPercent, 1),
          detail: `${formatBytes(memory.used)} / ${formatBytes(memory.total)}`,
          color: LEVEL_COLOR[levelOf(memory.usedPercent)]
        }),
        h(Meter, { percent: memory.usedPercent }),
        h(
          "div",
          { style: S.pills },
          h(Pill, { label: "可用", value: formatBytes(memory.available) }),
          h(Pill, { label: "缓存", value: formatBytes(memory.cached) }),
          h(Pill, {
            label: "Swap",
            value: `${formatPercent(swap.usedPercent, 1)} · ${formatBytes(swap.used)}`,
            color: levelOf(swapPercent) === 0 ? void 0 : LEVEL_COLOR[levelOf(swapPercent)]
          })
        )
      );
    }

    function GpuSection(props) {
      const gpu = props.snapshot.gpu ?? { available: false, devices: [], processes: [] };
      if (!gpu.available) {
        return h(
          Section,
          { title: "GPU" },
          h("div", { style: S.hint }, "无可用 NVIDIA GPU 遥测"),
          gpu.reason === null || gpu.reason === void 0 ? null : h(
            "div",
            { style: { ...S.hint, wordBreak: "break-word" } },
            String(gpu.reason).slice(0, 200)
          )
        );
      }
      const primary = gpu.devices[0];
      const processes = gpu.processes ?? [];
      return h(
        Section,
        {
          title: "GPU",
          aside: gpu.devices.length > 1 ? `${gpu.devices.length} 张 · ${primary.name}` : primary.name
        },
        h(StatRow, {
          label: "利用率",
          value: formatPercent(primary.utilizationGpu, 0),
          color: LEVEL_COLOR[levelOf(primary.utilizationGpu)]
        }),
        h(Meter, { percent: primary.utilizationGpu }),
        h(StatRow, {
          label: "显存",
          value: formatPercent(primary.memoryPercent, 1),
          detail: `${formatNumber(primary.memoryUsedMiB)} / ${formatNumber(primary.memoryTotalMiB)} MiB`,
          color: LEVEL_COLOR[levelOf(primary.memoryPercent)]
        }),
        h(Meter, { percent: primary.memoryPercent }),
        h(
          "div",
          { style: S.pills },
          h(Pill, {
            label: "温度",
            value: `${formatNumber(primary.temperatureC)}°C`,
            color: primary.temperatureC >= 85 ? LEVEL_COLOR[2] : primary.temperatureC >= 70 ? LEVEL_COLOR[1] : void 0
          }),
          h(Pill, { label: "功耗", value: `${formatNumber(primary.powerW)} / ${formatNumber(primary.powerLimitW)} W` }),
          primary.fanPercent === null ? null : h(Pill, { label: "风扇", value: `${formatNumber(primary.fanPercent)}%` }),
          h(Pill, { label: "SM", value: `${formatNumber(primary.clockSmMHz)} MHz` })
        ),
        gpu.devices.length > 1 ? h(
          "div",
          { style: S.coreGrid },
          gpu.devices.slice(1).map((device) =>
            h(
              "div",
              { key: device.index, title: device.name },
              h(
                "div",
                { style: S.coreTop },
                h("span", null, `g${device.index}`),
                h("span", null, percentText(device.utilizationGpu))
              ),
              h(
                "div",
                { style: S.coreTrack },
                h("span", {
                  style: {
                    display: "block",
                    height: "100%",
                    width: `${clampPercent(device.utilizationGpu) ?? 0}%`,
                    background: LEVEL_COLOR[levelOf(device.utilizationGpu)]
                  }
                })
              )
            )
          )
        ) : null,
        processes.length === 0 ? null : h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "4px" } },
          h("div", { style: { ...S.cardTitle, fontSize: "10px" } }, "显存进程"),
          processes.slice(0, 5).map((process) =>
            h(
              "div",
              { key: `${process.pid}-${process.name}`, style: S.row },
              h(
                "span",
                { style: { ...S.label, fontSize: "11px" }, title: `${process.name} #${process.pid}` },
                `${process.name} `,
                h("span", { style: { color: T.faint } }, `#${process.pid}`)
              ),
              h("span", { style: { ...S.value, fontSize: "11px", color: T.sub } }, `${formatNumber(process.memoryMiB)} MiB`)
            )
          )
        )
      );
    }

    function ThermalSection(props) {
      const thermals = props.snapshot.thermals ?? {};
      const temperatures = (Array.isArray(thermals.temperatures) ? thermals.temperatures : []).filter(
        (item) => typeof item.celsius === "number" && Number.isFinite(item.celsius)
      );
      const fans = thermals.fans ?? [];
      const power = thermals.power ?? [];
      if (temperatures.length === 0) {
        return h(
          Section,
          { title: "温度" },
          h("div", { style: S.hint }, "未发现 hwmon 温度传感器（lm-sensors/coretemp 未加载？）")
        );
      }
      const hottest = temperatures.reduce((best, item) => Math.max(best, item.celsius), -Infinity);
      return h(
        Section,
        { title: "温度", aside: `最高 ${formatNumber(hottest, 1)}°C` },
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "7px" } },
          temperatures.slice(0, 8).map((item) => {
            const level = item.celsius >= 85 ? 2 : item.celsius >= 70 ? 1 : 0;
            const width = Math.max(2, Math.min(100, (item.celsius / 100) * 100));
            return h(
              "div",
              { key: `${item.chip}/${item.label}`, title: `${item.chip} · ${item.label}` },
              h(
                "div",
                { style: { ...S.row, fontSize: "11px", lineHeight: "16px" } },
                h("span", { style: S.label }, item.label),
                h(
                  "span",
                  { style: { ...S.value, color: level === 0 ? T.sub : LEVEL_COLOR[level] } },
                  `${formatNumber(item.celsius, 1)}°C`
                )
              ),
              h(
                "div",
                { style: { ...S.coreTrack, marginTop: "4px" } },
                h("span", {
                  style: {
                    display: "block",
                    height: "100%",
                    width: `${width}%`,
                    borderRadius: "999px",
                    background: LEVEL_COLOR[level]
                  }
                })
              )
            );
          })
        ),
        fans.length === 0 && power.length === 0 ? null : h(
          "div",
          { style: S.pills },
          fans.map((fan) => h(Pill, { key: `${fan.chip}/${fan.label}`, value: `${fan.rpm} rpm`, label: fan.label })),
          power.map((entry) =>
            h(Pill, { key: `${entry.chip}/${entry.label}`, value: `${formatNumber(entry.watts, 1)} W`, label: entry.label })
          )
        )
      );
    }

    function ProcessSection(props) {
      const processes = props.snapshot.processes ?? {};
      const byCpu = Array.isArray(processes.byCpu) ? processes.byCpu : [];
      const byMemory = Array.isArray(processes.byMemory) ? processes.byMemory : [];
      if (byCpu.length === 0 && byMemory.length === 0) return null;
      const memMax = byMemory.reduce((max, item) => Math.max(max, item.rssBytes ?? 0), 1);
      const line = (item, right, key, index, ratio, tone) =>
        h(
          "div",
          { key, style: { ...S.row, position: "relative", gap: "8px", fontSize: "11px", lineHeight: "17px", paddingBottom: "3px" } },
          h(
            "span",
            { style: { display: "flex", alignItems: "baseline", gap: "7px", minWidth: 0 } },
            h("span", { style: { width: "12px", color: T.faint, fontVariantNumeric: "tabular-nums" } }, index + 1),
            h("span", { style: { ...S.label, fontSize: "11px" }, title: `${item.name} #${item.pid}` }, item.name)
          ),
          h("span", { style: { ...S.value, fontSize: "11px", color: T.sub, fontVariantNumeric: "tabular-nums" } }, right),
          ratio > 0.5 ? h("span", {
            style: {
              position: "absolute",
              left: "19px",
              bottom: 0,
              height: "3px",
              width: `calc(${Math.min(100, ratio)}% - 19px)`,
              borderRadius: "2px",
              background: tint(tone, 34)
            }
          }) : null
        );
      return h(
        Section,
        { title: "进程", aside: processes.total === null ? void 0 : `${processes.total} 个` },
        byCpu.length === 0 ? null : h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "3px" } },
          h("div", { style: { ...S.cardTitle, fontSize: "10px" } }, "CPU 占用最高"),
          byCpu.map((item, index) =>
            line(
              item,
              formatPercent(item.cpuPercent, 1),
              `cpu-${item.pid}-${index}`,
              index,
              Math.min(100, item.cpuPercent ?? 0),
              LEVEL_COLOR[levelOf(item.cpuPercent)]
            )
          )
        ),
        byMemory.length === 0 ? null : h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "3px" } },
          h("div", { style: { ...S.cardTitle, fontSize: "10px" } }, "内存占用最高"),
          byMemory.map((item, index) =>
            line(
              item,
              formatBytes(item.rssBytes),
              `mem-${item.pid}-${index}`,
              index,
              ((item.rssBytes ?? 0) / memMax) * 100,
              T.sub
            )
          )
        )
      );
    }

    /* ---------------------------------------------------------------- *
     * sidebar footer chip (always-visible summary + entry point)
     * ---------------------------------------------------------------- */

    /**
     * Compact CPU / memory / GPU summary in the left sidebar footer. It is the
     * discoverable entry point to the full panel: clicking opens the
     * right-sidebar tab. Polls slower than the panel, which refreshes on open.
     */
    function SystemChip() {
      const [snapshot, setSnapshot] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [navError, setNavError] = react.useState(null);
      react.useEffect(() => {
        let cancelled = false;
        let timer = null;
        const pull = async () => {
          try {
            const response = await fetch(SNAPSHOT_URL, { headers: { accept: "application/json" } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (!cancelled) {
              setSnapshot(payload);
              setError(null);
            }
          } catch (cause) {
            if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            if (!cancelled) timer = setTimeout(pull, CHIP_POLL_MS);
          }
        };
        pull();
        return () => {
          cancelled = true;
          if (timer !== null) clearTimeout(timer);
        };
      }, []);

      const gpuPercent = snapshot?.gpu?.available ? snapshot.gpu.devices?.[0]?.utilizationGpu ?? null : null;
      const hottest = (snapshot?.thermals?.temperatures ?? []).reduce(
        (best, item) => (item.celsius !== null && item.celsius !== void 0 && item.celsius > best ? item.celsius : best),
        -Infinity
      );
      const title = snapshot === null ?
        (error === null ? "系统监控：采样中…" : `系统监控不可用：${error}`) :
        [
          `CPU ${formatPercent(snapshot.cpu?.usage, 0)}`,
          `内存 ${formatPercent(snapshot.memory?.usedPercent, 0)}`,
          snapshot.gpu?.available ? `GPU ${formatPercent(gpuPercent, 0)}` : "GPU 无遥测",
          Number.isFinite(hottest) ? `最高温 ${formatNumber(hottest, 1)}°C` : null,
          navError === null ? "点击打开系统面板" : `打不开面板：${navError}`
        ].filter(Boolean).join(" · ");

      const cell = (label, value, percent) =>
        h(
          "span",
          { style: S.chipCell },
          h("span", { style: S.chipLabel }, label),
          h("span", { style: { ...S.chipValue, color: LEVEL_COLOR[levelOf(percent)] } }, value)
        );

      return h(
        "button",
        {
          type: "button",
          onClick: () => {
            const outcome = openSystemTab();
            setNavError(outcome.ok ? null : outcome.error);
          },
          title,
          style: S.chip
        },
        h(
          "span",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" } },
          h(
            "span",
            { style: { display: "inline-flex", alignItems: "center", gap: "6px", fontWeight: 600 } },
            h("span", {
              style: {
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: snapshot === null ? T.faint : T.green,
                boxShadow: snapshot === null ? "none" : `0 0 0 3px ${tint(T.green, 14)}`
              }
            }),
            "系统"
          ),
          h(
            "span",
            { style: { display: "inline-flex", alignItems: "baseline", gap: "9px" } },
            cell("CPU", formatPercent(snapshot?.cpu?.usage, 0), snapshot?.cpu?.usage),
            cell("MEM", formatPercent(snapshot?.memory?.usedPercent, 0), snapshot?.memory?.usedPercent),
            snapshot?.gpu?.available ?
              cell("GPU", formatPercent(gpuPercent, 0), gpuPercent) :
              h("span", { style: { color: T.faint } }, "GPU —")
          )
        ),
        error === null ? null : h("span", { style: { color: LEVEL_COLOR[2], fontSize: "10px", lineHeight: "14px" } }, error),
        navError === null ? null : h(
          "span",
          {
            style: {
              color: LEVEL_COLOR[2],
              fontSize: "10px",
              lineHeight: "14px",
              whiteSpace: "normal",
              wordBreak: "break-word"
            }
          },
          navError
        )
      );
    }

    /* ---------------------------------------------------------------- *
     * panel
     * ---------------------------------------------------------------- */

    function SystemPanel() {
      const [snapshot, setSnapshot] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [paused, setPaused] = react.useState(false);
      const [tick, setTick] = react.useState(0);
      const rootRef = react.useRef(null);
      const [panelWidth, setPanelWidth] = react.useState(0);

      react.useEffect(() => {
        const element = rootRef.current;
        if (element === null || typeof ResizeObserver === "undefined") return void 0;
        const observer = new ResizeObserver((entries) => {
          const width = entries[0]?.contentRect?.width;
          if (typeof width === "number" && Number.isFinite(width)) setPanelWidth(Math.round(width));
        });
        observer.observe(element);
        return () => observer.disconnect();
      }, []);

      react.useEffect(() => {
        if (paused) return void 0;
        let cancelled = false;
        let timer = null;
        const pull = async () => {
          try {
            const response = await fetch(SNAPSHOT_URL, { headers: { accept: "application/json" } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (!cancelled) {
              setSnapshot(payload);
              setError(null);
            }
          } catch (cause) {
            if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            if (!cancelled) timer = setTimeout(pull, POLL_MS);
          }
        };
        pull();
        return () => {
          cancelled = true;
          if (timer !== null) clearTimeout(timer);
        };
      }, [paused, tick]);

      const cpu = snapshot?.cpu ?? {};
      const memory = snapshot?.memory ?? {};
      const gpu = snapshot?.gpu ?? {};
      const gpuPercent = gpu.available ? gpu.devices?.[0]?.utilizationGpu ?? null : null;
      const history = snapshot?.history ?? [];
      const wide = panelWidth >= 520;
      const chartHeight = panelWidth >= 900 ? 56 : wide ? 46 : 26;
      const worstLevel = Math.max(
        levelOf(cpu.usage),
        levelOf(memory.usedPercent),
        gpu.available ? levelOf(gpuPercent) : 0
      );
      const health = [
        { label: "正常", color: T.green },
        { label: "偏高", color: LEVEL_COLOR[1] },
        { label: "告警", color: LEVEL_COLOR[2] }
      ][worstLevel];

      const trend = (points) => {
        const values = (points ?? []).filter((value) => typeof value === "number" && Number.isFinite(value));
        if (values.length < 6) return null;
        return values[values.length - 1] - values[Math.max(0, values.length - 31)];
      };

      const vital = (label, percent, digits, points, forcedColor, empty) => {
        const color = forcedColor ?? (percent === null || percent === void 0 ? T.sub : LEVEL_COLOR[levelOf(percent)]);
        const delta = trend(points);
        return h(
          "div",
          {
            key: label,
            style: S.tile,
            title: delta === null ? void 0 : `近 30 秒 ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} 个百分点`
          },
          h(
            "div",
            { style: S.tileTop },
            h(
              "div",
              { style: { minWidth: 0 } },
              h("div", { style: S.tileLabel }, label),
              h(
                "div",
                { style: { ...S.tileValue, color } },
                percent === null || percent === void 0 ? "—" : formatNumber(percent, digits),
                percent === null || percent === void 0 ? null : h("span", { style: S.heroUnit }, "%")
              )
            ),
            delta === null || Math.abs(delta) < 0.05 ? null : h(
              "span",
              {
                style: {
                  ...S.delta,
                  color: delta > 1 ? LEVEL_COLOR[1] : delta < -1 ? T.green : T.faint
                }
              },
              `${delta > 0 ? "▲" : "▼"}${Math.abs(delta).toFixed(1)}`
            )
          ),
          h(Sparkline, { points, height: chartHeight, wide, empty, color })
        );
      };

      const body = [];
      if (snapshot === null) {
        body.push(h("div", { key: "boot", style: S.hint }, error === null ? "采样中…" : ""));
        body.push(h("div", { key: "boot-panel", style: S.card }, h("div", { style: S.hint }, "正在读取系统遥测…")));
      } else {
        if (error !== null) body.push(h("div", { key: "err", style: S.error }, `最近一次读取失败：${error}`));
        body.push(h(CpuSection, { key: "cpu", snapshot }));
        body.push(h(MemorySection, { key: "mem", snapshot }));
        body.push(h(GpuSection, { key: "gpu", snapshot }));
        body.push(h(ThermalSection, { key: "thermal", snapshot }));
        body.push(h(ProcessSection, { key: "proc", snapshot }));
      }

      return h(
        "div",
        { ref: rootRef, style: S.root },
        h(
          "div",
          { style: S.header },
          h(
            "div",
            { style: { minWidth: 0 } },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "8px" } },
              h("div", { style: S.title }, "系统负载"),
              snapshot === null ? null : h(
                "span",
                {
                  style: { ...S.statePill, color: health.color, background: tint(health.color, 12) },
                  title: `CPU ${formatPercent(cpu.usage, 0)} · 内存 ${formatPercent(memory.usedPercent, 0)}${
                    gpu.available ? ` · GPU ${formatPercent(gpuPercent, 0)}` : ""
                  }`
                },
                h("span", { style: { width: "5px", height: "5px", borderRadius: "50%", background: health.color } }),
                health.label
              )
            ),
            h(
              "div",
              { style: S.subtitle },
              h("span", {
                style: {
                  ...S.liveDot,
                  background: paused ? T.faint : T.green,
                  boxShadow: paused ? "none" : `0 0 0 3px ${tint(T.green, 14)}`
                }
              }),
              h(
                "span",
                { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
                paused ? "已暂停刷新" : `运行 ${formatUptime(snapshot?.uptimeSeconds)} · 每 1s 刷新`
              )
            )
          ),
          h(
            "div",
            { style: S.actions },
            h(
              "button",
              {
                type: "button",
                style: S.button,
                title: paused ? "继续每秒刷新" : "暂停刷新",
                onClick: () => setPaused((value) => !value)
              },
              paused ? "继续" : "暂停"
            ),
            h(
              "button",
              {
                type: "button",
                style: S.button,
                title: "立即刷新",
                onClick: () => setTick((value) => value + 1)
              },
              "刷新"
            )
          )
        ),
        h(
          "div",
          { style: S.hero },
          h(
            "div",
            { style: S.heroGrid },
            vital("CPU", typeof cpu.usage === "number" ? cpu.usage : null, 1, history.map((entry) => entry.cpu)),
            vital("内存", typeof memory.usedPercent === "number" ? memory.usedPercent : null, 1, history.map((entry) => entry.mem)),
            gpu.available ?
              vital("GPU", gpuPercent, 0, history.map((entry) => entry.gpu)) :
              vital("GPU", null, 0, [], null, "无 GPU 遥测")
          )
        ),
        body
      );
    }

    const inject = ["slots", "sidebarRightTabs", "sidebarRight", "layout"];

    function apply(ctx) {
      pluginCtx = ctx;
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TYPE_ID,
            kind: TAB_KIND,
            title: () => "系统",
            guide: [{ kind: TAB_KIND, title: "系统监控", description: "CPU / 内存 / GPU / 温度", order: 50 }]
          }),
        "dsh-system-monitor: tab type"
      );
      // Always-visible chip: the entry point that does not require the user to
      // discover the right sidebar first.
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.footer.action", () =>
            ctx.slots.register({ name: "sidebar.footer.action", id: "system-monitor", order: 20 }, SystemChip)
          ),
        "dsh-system-monitor: sidebar chip"
      );
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.right.pane.tab", () =>
            ctx.slots.register({ name: "sidebar.right.pane.tab", key: TYPE_ID }, SystemPanel)
          ),
        "dsh-system-monitor: tab body"
      );
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.right.pane.tab.title", () =>
            ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TYPE_ID }, () => h("span", null, "系统"))
          ),
        "dsh-system-monitor: tab title"
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
