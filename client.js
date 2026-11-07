window.__ModuleLoader__.load({
  id: "dsh-live-compact",
  factory(require) {
    /**
     * 设置界面。全走宿主原生接口：configForms 拿配置作用域，官方 SettingsFormModel 管草稿与写回，
     * 官方 settingsNumberField 声明字段，官方插件页槽位挂载，官方 ctx.locale 出词典。
     * 入口是宿主的 __ModuleLoader__ 产物，因此没有 JSX、没有构建步骤。
     * 表 GROUPS 是唯一的业务：常用与高级设置两栏。
     * Native configForms + SettingsFormModel + settingsNumberField; no JSX, no build step.
     */
    const React = require("react");
    const { SettingsFormModel, settingsNumberField } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;

    const NS = "compaction-spine";
    const GROUPS = [
      { id: "basic", keys: ["minTokens", "pointerTokens", "keepRounds"] },
      {
        id: "advanced",
        keys: [
          "chunkMin", "chunkMax", "keepRoundTokens", "bigGate", "cooldownMs",
          "thresholdRatio", "headroomTokens", "retainTokens", "compactionRetries",
        ],
      },
    ];
    const KEYS = GROUPS.flatMap((group) => group.keys);
    const LABELS = {
      minTokens: ["起切 token 数", "默认 20000"],
      pointerTokens: ["大结果只留指针", "0 = 跟随一刀上限"],
      keepRounds: ["保留原文轮数", "默认 3"],
      chunkMin: ["一刀最小 token", "默认 1000"],
      chunkMax: ["一刀最大 token", "默认 32000"],
      keepRoundTokens: ["收尾停止线", "默认 32000"],
      bigGate: ["绝对停切线", "默认 650000"],
      cooldownMs: ["官方压缩后冷却 ms", "0 = 只跳过一次"],
      thresholdRatio: ["官方大压缩触发比例", "默认 0.8"],
      headroomTokens: ["官方大压缩预留", "默认 65536"],
      retainTokens: ["官方大压缩保留", "默认 8192"],
      compactionRetries: ["官方大压缩重试", "默认 0"],
    };

    const zh = {
      summary: "20000 起切、3 轮留原文、650000 停",
      basic: "常用",
      advanced: "高级设置",
      save: "保存",
      saving: "保存中…",
      discard: "放弃修改",
      invalid: "有值不合法",
      unavailable: "当前配置不可写",
      unavailableHost: "宿主没有提供这一项配置",
    };
    const en = {
      summary: "cuts at 20000, keeps 3 rounds, stops at 650000",
      basic: "Common",
      advanced: "Advanced",
      save: "Save",
      saving: "Saving…",
      discard: "Discard",
      invalid: "A value is invalid",
      unavailable: "Configuration is not writable",
      unavailableHost: "The host does not serve this namespace",
    };

    const rowStyle = { display: "flex", gap: "0.75rem", alignItems: "center", margin: "0.35rem 0" };

    function createUi(ctx, t) {
      const model = new SettingsFormModel(
        ctx.configForms.get(NS),
        KEYS.map((key) => settingsNumberField(key)),
      );
      const read = () => ({
        shell: model.shell(),
        fields: Object.fromEntries(KEYS.map((key) => [key, model.field(key)])),
      });
      const store = model.bind(read);

      function Field(props) {
        const { name, field, disabled } = props;
        const [label, hint] = LABELS[name] || [name, ""];
        return h("label", { style: rowStyle },
          h("span", { style: { flex: "0 0 12rem" } }, t(label) === label ? label : t(label)),
          h("input", {
            type: "number",
            value: field && field.text !== undefined ? field.text : "",
            disabled: disabled || !(field && field.writable),
            onChange: (event) => model.actions().edit(field, event.target.value),
          }),
          h("span", { style: { opacity: 0.6, fontSize: "0.85em" } }, hint),
          field && field.error ? h("span", { style: { color: "var(--dsw-alias-state-error-primary)" } }, String(field.error)) : null);
      }

      function SettingsForm() {
        const [snapshot, setSnapshot] = React.useState(read);
        React.useEffect(() => {
          const unsubscribe = store.subscribe(() => setSnapshot(read()));
          return typeof unsubscribe === "function" ? unsubscribe : undefined;
        }, []);
        const { shell, fields } = snapshot;
        if (!shell.available) return h("p", { role: "status" }, t("unavailableHost"));
        const section = (group) => group.keys.map((name) =>
          h(Field, { key: name, name, field: fields[name], disabled: !shell.writable }));
        return h("form", {
          onSubmit: (event) => {
            event.preventDefault();
            void model.save();
          },
        },
        h("h4", { style: { margin: "0 0 0.5rem" } }, t("basic")),
        section(GROUPS[0]),
        h("details", { style: { marginTop: "0.75rem" } },
          h("summary", { style: { cursor: "pointer" } }, t("advanced")),
          section(GROUPS[1])),
        h("div", { style: { display: "flex", gap: "0.5rem", marginTop: "0.75rem" } },
          h("button", { type: "submit", disabled: !shell.writable || shell.saving || shell.invalid },
            t(shell.saving ? "saving" : "save")),
          h("button", {
            type: "button",
            disabled: shell.saving || !shell.dirty,
            onClick: () => model.actions().discard(),
          }, t("discard"))),
        shell.invalid ? h("p", { role: "status" }, t("invalid")) : null,
        !shell.writable ? h("p", { role: "status" }, t("unavailable")) : null);
      }

      return { model, SettingsForm };
    }

    return {
      inject: ["slots", "locale", "configForms"],
      apply(ctx) {
        const t = ctx.locale.bind("liveCompact");
        ctx.effect(() => ctx.locale.register("liveCompact", { zh, en }), "live-compact: settings dictionary");
        const { SettingsForm } = createUi(ctx, t);
        ctx.effect(() => ctx.slots.inject("plugins.row.config", () => ctx.slots.register(
          { name: "plugins.row.config", key: "dsh-live-compact#compaction-spine", locale: "liveCompact" },
          (props) => (props.view === "summary" ? h("span", null, props.t("summary")) : h(SettingsForm)),
        )), "live-compact: settings page");
      },
    };
  },
});
