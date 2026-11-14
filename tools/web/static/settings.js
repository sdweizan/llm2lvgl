/* llm2lvgl 模型配置页 —— 供应商 TAB 面板，内置常用模型 */
(function () {
  "use strict";

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];

  const llm = {
    providers: [],   // [{id, name, base_url, api_key, models: [name, ...]}]
    roles: { analyze: "", generate: "", refine: "" },
    default_model: "",
    role_names: { analyze: "图形/页面分析", generate: "代码生成", refine: "精调修正" },
    activeTab: 0,
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  async function safeJson(res) {
    try {
      return await res.json();
    } catch (e) {
      return {};
    }
  }

  function showToast(message, type) {
    const stack = $("#toast-stack");
    if (!stack) return;
    const toast = document.createElement("div");
    toast.className = `toast ${type || ""}`.trim();
    toast.textContent = message;
    stack.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  async function loadSettings() {
    let savedProviders = [];
    let savedModels = [];
    let roles = { analyze: "", generate: "", refine: "" };
    let default_model = "";
    let presets = [];

    try {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      savedProviders = Array.isArray(data.providers) ? data.providers : [];
      savedModels = Array.isArray(data.models) ? data.models : [];
      roles = data.roles || roles;
      default_model = data.default_model || "";
      presets = Array.isArray(data.provider_presets) ? data.provider_presets : [];
      if (data.role_names) llm.role_names = data.role_names;
    } catch (e) {
      // Settings are optional during first run.
    }

    const providerById = {};
    savedProviders.forEach((p) => { providerById[p.id] = p; });
    const modelsByProvider = {};
    savedModels.forEach((m) => {
      if (!modelsByProvider[m.provider]) modelsByProvider[m.provider] = [];
      modelsByProvider[m.provider].push(m.model || m.id || m.name);
    });

    llm.providers = presets.map((p) => {
      const saved = providerById[p.id];
      const hasSaved = Boolean(saved);
      return {
        id: p.id,
        name: p.name || p.id,
        base_url: (saved && saved.base_url) || p.base_url || "",
        api_key: (saved && saved.api_key) || "",
        // Once a provider has been saved once, respect its saved model list
        // (even if empty); only the very first load seeds common_models.
        models: hasSaved
          ? (modelsByProvider[p.id] || [])
          : (p.common_models || []).slice(),
      };
    });

    llm.roles = roles;
    llm.default_model = default_model;
    if (llm.activeTab >= llm.providers.length) llm.activeTab = 0;

    renderTabs();
    renderPanels();
    renderRoles();
  }

  function allModelNames() {
    const seen = new Set();
    llm.providers.forEach((p) => {
      (p.models || []).forEach((n) => {
        const name = (n || "").trim();
        if (name) seen.add(name);
      });
    });
    return [...seen];
  }

  function modelOptions(selected) {
    const opts = ['<option value="">（默认）</option>'];
    for (const name of allModelNames()) {
      opts.push(`<option value="${escapeHtml(name)}"${name === selected ? " selected" : ""}>${escapeHtml(name)}</option>`);
    }
    return opts.join("");
  }

  function renderTabs() {
    const bar = $("#provider-tabs");
    if (!bar) return;
    bar.innerHTML = llm.providers.map((p, i) => `
      <button class="provider-tab${i === llm.activeTab ? " active" : ""}"
              data-tab="${i}" type="button" role="tab" aria-selected="${i === llm.activeTab}">
        ${escapeHtml(p.name)}${p.api_key ? " ✓" : ""}
      </button>
    `).join("");
  }

  function renderPanels() {
    const wrap = $("#provider-tab-panels");
    if (!wrap) return;

    wrap.innerHTML = llm.providers.map((p, pi) => {
      const modelRows = (p.models || []).map((name, mi) => `
        <div class="settings-item settings-item--model" data-model-idx="${mi}">
          <input class="m-name" data-field="name" value="${escapeHtml(name)}" placeholder="模型名称" autocomplete="off" spellcheck="false">
          <button class="settings-remove" data-remove-model="${mi}" type="button" aria-label="删除模型">✕</button>
        </div>
      `).join("");

      return `
        <div class="provider-panel${pi === llm.activeTab ? "" : " hidden"}" data-provider-idx="${pi}" role="tabpanel" aria-hidden="${pi !== llm.activeTab}">
          <div class="form-group">
            <label>API Key</label>
            <input class="p-key" data-field="api_key" type="password" value="${escapeHtml(p.api_key)}" placeholder="API Key" autocomplete="off" spellcheck="false">
          </div>
          <div class="form-group">
            <label>Base URL</label>
            <input class="p-base" data-field="base_url" value="${escapeHtml(p.base_url)}" placeholder="Base URL（/v1 根路径）" autocomplete="off">
          </div>
          <div class="form-group">
            <label>模型</label>
            ${modelRows || '<p class="field-hint">尚未添加模型</p>'}
            <button class="btn btn-secondary btn-sm" data-add-model="${pi}" type="button">+ 添加模型</button>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderRoles() {
    const list = $("#role-list");
    if (!list) return;
    const roleOrder = ["analyze", "generate", "refine"];
    const items = roleOrder.map((role) => `
      <div class="settings-item settings-item--role">
        <label class="role-label">${escapeHtml(llm.role_names[role] || role)}</label>
        <select class="role-select" data-role="${role}">${modelOptions(llm.roles[role] || "")}</select>
      </div>
    `).join("");
    list.innerHTML = `
      <div class="settings-item settings-item--role">
        <label class="role-label">默认模型</label>
        <select class="role-select" data-role="default">${modelOptions(llm.default_model || "")}</select>
      </div>
      ${items}
    `;
  }

  function collectSettingsFromDom() {
    const providers = [];
    const models = [];

    llm.providers.forEach((p) => {
      providers.push({
        id: p.id,
        name: p.name,
        base_url: (p.base_url || "").trim(),
        api_key: (p.api_key || "").trim(),
      });
      (p.models || []).forEach((n) => {
        const name = (n || "").trim();
        if (!name) return;
        models.push({ id: name, name: name, provider: p.id, model: name, vision: false });
      });
    });

    let default_model = "";
    const roles = {};
    $$(".role-select").forEach((sel) => {
      if (sel.dataset.role === "default") default_model = sel.value;
      else roles[sel.dataset.role] = sel.value;
    });

    return { providers, models, roles, default_model };
  }

  async function saveSettings() {
    const msg = $("#settings-msg");
    msg.textContent = "保存中...";
    msg.style.color = "var(--muted)";
    const body = collectSettingsFromDom();

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        llm.roles = body.roles;
        llm.default_model = body.default_model;
        msg.textContent = "已保存";
        msg.style.color = "var(--success)";
        showToast("模型设置已保存", "success");
      } else {
        const err = await safeJson(res);
        msg.textContent = err.error || "保存失败";
        msg.style.color = "var(--error)";
        showToast(msg.textContent, "error");
      }
    } catch (e) {
      msg.textContent = "错误: " + e.message;
      msg.style.color = "var(--error)";
      showToast(msg.textContent, "error");
    }

    setTimeout(() => { msg.textContent = ""; }, 3000);
  }

  function switchTab(idx) {
    llm.activeTab = idx;
    $$("#provider-tabs .provider-tab").forEach((b, i) => {
      b.classList.toggle("active", i === idx);
      b.setAttribute("aria-selected", String(i === idx));
    });
    $$("#provider-tab-panels .provider-panel").forEach((pn, i) => {
      pn.classList.toggle("hidden", i !== idx);
      pn.setAttribute("aria-hidden", String(i !== idx));
    });
  }

  function onTabClick(e) {
    const tab = e.target.closest("[data-tab]");
    if (!tab) return;
    switchTab(Number(tab.dataset.tab));
  }

  function addModel(providerIdx) {
    const provider = llm.providers[providerIdx];
    if (!provider) return;
    provider.models.push("");
    renderPanels();
    switchTab(providerIdx);
  }

  function onClick(e) {
    const addModelBtn = e.target.closest("[data-add-model]");
    if (addModelBtn) {
      addModel(Number(addModelBtn.dataset.addModel));
      return;
    }

    const removeModel = e.target.closest("[data-remove-model]");
    if (removeModel) {
      const panel = removeModel.closest("[data-provider-idx]");
      const pi = Number(panel.dataset.providerIdx);
      const mi = Number(removeModel.dataset.removeModel);
      llm.providers[pi].models.splice(mi, 1);
      renderPanels();
      renderRoles();
      return;
    }
  }

  function onInput(e) {
    const panel = e.target.closest("[data-provider-idx]");
    if (!panel) return;
    const pi = Number(panel.dataset.providerIdx);
    if (!llm.providers[pi]) return;

    const modelRow = e.target.closest("[data-model-idx]");
    if (modelRow) {
      const mi = Number(modelRow.dataset.modelIdx);
      if (llm.providers[pi].models[mi] !== undefined) {
        llm.providers[pi].models[mi] = e.target.value;
      }
      return;
    }

    const field = e.target.dataset.field;
    if (field === "api_key" || field === "base_url") {
      llm.providers[pi][field] = e.target.value;
      // Refresh the tab's ✓ marker when a key is typed.
      if (field === "api_key") renderTabs();
    }
  }

  function init() {
    $("#save-settings-btn").addEventListener("click", saveSettings);
    const tabs = $("#provider-tabs");
    tabs.addEventListener("click", onTabClick);
    const body = document.querySelector(".settings-body");
    body.addEventListener("click", onClick);
    body.addEventListener("input", onInput);
    loadSettings();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
