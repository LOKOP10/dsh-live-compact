import React from "react";

/**
 * 设置界面。走宿主官方的客户端槽位和配置写接口，不自带传输、不自带界面框架：
 *   - 表单数据来自 props.form（ConfigPageForm），写入走 form.mutate(ops, revision)；
 *   - 词典走 ctx.locale.register，控件用 React.createElement，因此没有 JSX、没有构建步骤。
 * 这张 FIELDS 表就是这个文件的全部"业务"：别的插件拿走本文件改表即可复用。
 * Native slots + native config writes only; no JSX, no build step, no transport of our own.
 */

export const name = "dsh-live-compact/settings";
export const inject = ["slots", "locale"];

export const FIELDS = [
  { key: "minTokens", section: "basic", label: "起切 token 数", hint: "默认 20000" },
  { key: "pointerTokens", section: "basic", label: "大结果只留指针", hint: "0 = 跟随一刀上限" },
  { key: "keepRounds", section: "basic", label: "保留原文轮数", hint: "默认 3" },
  { key: "auto", section: "basic", label: "自动压缩", kind: "bool" },
  { key: "chunkMin", section: "advanced", label: "一刀最小 token", hint: "默认 1000" },
  { key: "chunkMax", section: "advanced", label: "一刀最大 token", hint: "默认 32000" },
  { key: "keepRoundTokens", section: "advanced", label: "收尾停止线", hint: "默认 32000" },
  { key: "bigGate", section: "advanced", label: "绝对停切线", hint: "默认 650000" },
  { key: "cooldownMs", section: "advanced", label: "官方压缩后冷却 ms", hint: "0 = 只跳过一次" },
  { key: "thresholdRatio", section: "advanced", label: "官方大压缩触发比例", hint: "默认 0.8" },
  { key: "headroomTokens", section: "advanced", label: "官方大压缩预留 token", hint: "默认 65536" },
  { key: "retainTokens", section: "advanced", label: "官方大压缩保留 token", hint: "默认 8192" },
  { key: "compactionRetries", section: "advanced", label: "官方大压缩重试次数", hint: "默认 0" },
];

const zh = {
  title: "边做边压",
  summary: "20000 起切、3 轮留原文、650000 停",
  basic: "常用",
  advanced: "高级设置",
  save: "保存",
  saving: "保存中…",
  reset: "还原",
  saved: "已保存",
  rejected: "配置已被别处改动，请刷新后再改",
  loading: "读取中…",
  unavailable: "当前配置不可写",
  readonly: "只读",
};

const en = {
  title: "Live Compact",
  summary: "cuts at 20000, keeps 3 rounds, stops at 650000",
  basic: "Common",
  advanced: "Advanced",
  save: "Save",
  saving: "Saving…",
  reset: "Reset",
  saved: "Saved",
  rejected: "Configuration changed elsewhere; reload and retry",
  loading: "Loading…",
  unavailable: "Configuration is not writable",
  readonly: "Read only",
};

const h = (...args) => React.createElement(...args);

function fieldValue(form, field) {
  const raw = form?.state?.value?.[field.key];
  return field.kind === "bool" ? raw === true : Number(raw ?? 0);
}

function Field({ form, field, t, edit }) {
  const value = fieldValue(form, field);
  const input = field.kind === "bool"
    ? h("input", {
      type: "checkbox",
      checked: value,
      onChange: (event) => edit(field.key, event.target.checked),
    })
    : h("input", {
      type: "number",
      value,
      onChange: (event) => edit(field.key, Number(event.target.value)),
    });

  return h("label", { style: { display: "flex", gap: "0.75rem", alignItems: "center", margin: "0.35rem 0" } },
    h("span", { style: { flex: "0 0 12rem" } }, t(field.label)),
    input,
    field.hint ? h("span", { style: { opacity: 0.6, fontSize: "0.85em" } }, t(field.hint)) : null);
}

export function SettingsForm(props) {
  const { form, t } = props;
  const state = form?.state;
  const [draft, setDraft] = React.useState(() => state?.value ?? {});
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");

  React.useEffect(() => {
    if (!busy) setDraft(form?.state?.value ?? {});
  }, [form?.state?.revision, form?.state?.status]);

  if (!state) return h("p", null, t("loading"));
  const ready = state.status === "ready" && state.writable && state.mode === "host";
  const edit = (key, value) => {
    setDraft({ ...draft, [key]: value });
    setMessage("");
  };
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const ops = FIELDS
        .filter((field) => draft[field.key] !== undefined && draft[field.key] !== state.value[field.key])
        .map((field) => ({ op: "set", path: [field.key], value: draft[field.key] }));
      if (!ops.length) return;
      setMessage(t((await form.mutate(ops, state.revision)) ? "saved" : "rejected"));
    } finally {
      setBusy(false);
    }
  };

  const section = (name) => FIELDS
    .filter((field) => field.section === name)
    .map((field) => h(Field, { key: field.key, form: { state: { value: draft } }, field, t, edit }));

  return h("form", {
    onSubmit: (event) => {
      event.preventDefault();
      void save();
    },
    style: { display: "block" },
  },
  h("h4", { style: { margin: "0 0 0.5rem" } }, t("basic")),
  section("basic"),
  h("details", { style: { marginTop: "0.75rem" } },
    h("summary", { style: { cursor: "pointer" } }, t("advanced")),
    section("advanced")),
  h("div", { style: { display: "flex", gap: "0.5rem", marginTop: "0.75rem" } },
    h("button", { type: "submit", disabled: !ready || busy }, t(busy ? "saving" : "save")),
    h("button", {
      type: "button",
      disabled: busy,
      onClick: () => {
        setDraft(form?.state?.value ?? {});
        setMessage("");
      },
    }, t("reset"))),
  !ready ? h("p", { role: "status" }, t("unavailable")) : null,
  message ? h("p", { role: "status" }, message) : null);
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register("liveCompact", { zh, en }), "live-compact: settings dictionary");
  ctx.slots.inject("plugins.row.config", function* () {
    yield ctx.slots.register(
      { name: "plugins.row.config", key: "dsh-live-compact#compaction-spine", locale: "liveCompact" },
      (props) => (props.view === "summary" ? h("span", null, props.t("summary")) : h(SettingsForm, props)),
    );
  });
}
