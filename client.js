window.__ModuleLoader__.load({
  id: "dsh-live-compact",
  factory(require) {
    /**
     * 设置界面。只用宿主自己的东西：客户端槽位、官方 form.mutate 写配置、官方 locale 词典、
     * require("react")。宿主加载的就是这个 __ModuleLoader__ 产物，所以不需要构建步骤。
     * 表 FIELDS 是这里唯一的业务：分「常用」和「高级设置」两栏。别的插件拿走本文件改表即可复用。
     * Native slots, native config writes, native dictionary; no JSX and no build step.
     */
    const React = require("react");
    const h = React.createElement;

    const FIELDS = [
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
    };

    const en = {
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
    };

    const valueOf = (values, field) =>
      field.kind === "bool" ? values[field.key] === true : Number(values[field.key] ?? 0);

    const rowStyle = { display: "flex", gap: "0.75rem", alignItems: "center", margin: "0.35rem 0" };

    function Field(props) {
      const { values, field, t, edit } = props;
      const input = field.kind === "bool"
        ? h("input", {
          type: "checkbox",
          checked: valueOf(values, field),
          onChange: (event) => edit(field.key, event.target.checked),
        })
        : h("input", {
          type: "number",
          value: valueOf(values, field),
          onChange: (event) => edit(field.key, Number(event.target.value)),
        });
      return h("label", { style: rowStyle },
        h("span", { style: { flex: "0 0 12rem" } }, t(field.label)),
        input,
        field.hint ? h("span", { style: { opacity: 0.6, fontSize: "0.85em" } }, t(field.hint)) : null);
    }

    function SettingsForm(props) {
      const { form, t } = props;
      const state = form && form.state;
      const [draft, setDraft] = React.useState(() => (state && state.value) || {});
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState("");

      React.useEffect(() => {
        if (!busy) setDraft((form && form.state && form.state.value) || {});
      }, [form && form.state && form.state.revision, form && form.state && form.state.status]);

      if (!state) return h("p", { role: "status" }, t("loading"));

      const ready = state.status === "ready" && state.writable && state.mode === "host";
      const edit = (key, value) => {
        setDraft({ ...draft, [key]: value });
        setMessage("");
      };
      const save = async () => {
        if (!ready || busy) return;
        const ops = FIELDS
          .filter((field) => draft[field.key] !== undefined && draft[field.key] !== state.value[field.key])
          .map((field) => ({ op: "set", path: [field.key], value: draft[field.key] }));
        if (!ops.length) { setMessage(""); return; }
        setBusy(true);
        try {
          setMessage(t((await form.mutate(ops, state.revision)) ? "saved" : "rejected"));
        } finally {
          setBusy(false);
        }
      };

      const section = (name) => FIELDS
        .filter((field) => field.section === name)
        .map((field) => h(Field, { key: field.key, values: draft, field, t, edit }));

      return h("form", {
        onSubmit: (event) => {
          event.preventDefault();
          void save();
        },
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
            setDraft((form && form.state && form.state.value) || {});
            setMessage("");
          },
        }, t("reset"))),
      ready ? null : h("p", { role: "status" }, t("unavailable")),
      message ? h("p", { role: "status" }, message) : null);
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register("liveCompact", { zh, en }), "live-compact: settings dictionary");
        ctx.slots.inject("plugins.row.config", function* () {
          yield ctx.slots.register(
            { name: "plugins.row.config", key: "dsh-live-compact#compaction-spine", locale: "liveCompact" },
            (props) => (props.view === "summary" ? h("span", null, props.t("summary")) : h(SettingsForm, props)),
          );
        });
      },
    };
  },
});
