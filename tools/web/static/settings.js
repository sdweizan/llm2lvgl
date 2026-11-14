/* llm2lvgl 模型配置页 */
(function () {
  "use strict";

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];

  const llm = {
    providers: [],
    models: [],
    roles: { analyze: "", generate: "", refine: "" },
    default_model: "",
    provider_presets: [],
    role_names: { analyze: "图形/页面分析", generate: "代码生成", refine: "精调修正" },
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
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      const data = await res.json();
      llm.providers = Array.isArray(data.providers) ? data.providers : [];
      llm.models = Array.isArray(data.models) ? data.models : [];
      llm.roles = data.roles || { analyze: "", generate: "", refine: "" };
      llm.default_model = data.default_model || "";
      llm.provider_presets = Array.isArray(data.provider_presets) ? data.provider_presets : [];
      llm.role_names = data.role_names || llm.role_names;
      renderPresetSelect();
      renderProviders();
      renderModels();
      renderRoles();
    } catch (e) {
      // Settings are optional during first run.
    }
  }

  function providerOptions(selected) {
    return llm.providers.map((p) =>
      `<option value="${escapeHtml(p.id)}"${p.id === selected ? " selected" : ""}>${escapeHtml(p.name || p.id)}</option>`
    ).join("");
  }

  function modelOptions(selected) {
    const opts = ['<option value="">（默认）</option>'];
    for (const m of llm.models) {
      opts.push(`<option value="${escapeHtml(m.id)}"${m.id === selected ? " selected" : ""}>${escapeHtml(m.name || m.id)}</option>`);
    }
    return opts.join("");
  }

  function renderPresetSelect() {
    const sel = $("#provider-preset-select");
    const datalist = $("#provider-base-presets");
    if (!sel) return;
    sel.innerHTML = '<option value="">选择预设供应商…</option>' +
      llm.provider_presets.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
    if (datalist) {
      datalist.innerHTML = llm.provider_presets
        .filter((p) => p.base_url)
        .map((p) => `<option value="${escapeHtml(p.base_url)}">${escapeHtml(p.name)}</option>`).join("");
    }
  }

  function renderProviders() {
    const list = $("#provider-list");
    if (!list) return;
    list.innerHTML = llm.providers.map((p, i) => `
      <div class="settings-item" data-provider-idx="${i}">
        <div class="settings-grid settings-grid--provider">
          <input class="p-id" data-field="id" value="${escapeHtml(p.id)}" placeholder="ID（唯一）" autocomplete="off" spellcheck="false">
          <input class="p-name" data-field="name" value="${escapeHtml(p.name)}" placeholder="名称" autocomplete="off">
          <input class="p-base" data-field="base_url" value="${escapeHtml(p.base_url)}" placeholder="Base URL（/v1 根路径）" list="provider-base-presets" autocomplete="off">
          <input class="p-key" data-field="api_key" type="password" value="${escapeHtml(p.api_key)}" placeholder="API Key" autocomplete="off" spellcheck="false">
        </div>
        <button class="settings-remove" data-remove-provider="${i}" type="button" aria-label="删除供应商">✕</button>
      </div>
    `).join("");
    syncModelProviderOptions();
  }

  function renderModels() {
    const list = $("#model-list");
    if (!list) return;
    list.innerHTML = llm.models.map((m, i) => `
      <div class="settings-item" data-model-idx="${i}">
        <div class="settings-grid settings-grid--model">
          <input class="m-id" data-field="id" value="${escapeHtml(m.id)}" placeholder="昵称" autocomplete="off" spellcheck="false">
          <input class="m-name" data-field="name" value="${escapeHtml(m.name)}" placeholder="显示名称" autocomplete="off">
          <select class="m-provider" data-field="provider" aria-label="供应商">${providerOptions(m.provider)}</select>
          <input class="m-model" data-field="model" value="${escapeHtml(m.model)}" placeholder="真实模型名" autocomplete="off" spellcheck="false">
          <label class="m-vision"><input type="checkbox" class="m-vision-box" data-field="vision"${m.vision ? " checked" : ""}> 视觉</label>
        </div>
        <button class="settings-remove" data-remove-model="${i}" type="button" aria-label="删除模型">✕</button>
      </div>
    `).join("");
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

  function syncModelProviderOptions() {
    const selects = $$(".m-provider");
    if (!selects.length) return;
    const current = selects.map((sel) => sel.value);
    selects.forEach((sel, i) => {
      const cur = current[i];
      sel.innerHTML = llm.providers.map((p) =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join("");
      if (llm.providers.some((p) => p.id === cur)) sel.value = cur;
    });
  }

  function collectSettingsFromDom() {
    const providers = $$("#provider-list .settings-item").map((row) => {
      const read = (sel) => { const el = row.querySelector(sel); return el ? el.value.trim() : ""; };
      return { id: read(".p-id"), name: read(".p-name"), base_url: read(".p-base"), api_key: read(".p-key") };
    }).filter((p) => p.id);

    const models = $$("#model-list .settings-item").map((row) => {
      const read = (sel) => { const el = row.querySelector(sel); return el ? el.value.trim() : ""; };
      const vision = row.querySelector(".m-vision-box");
      return {
        id: read(".m-id"),
        name: read(".m-name"),
        provider: read(".m-provider"),
        model: read(".m-model"),
        vision: Boolean(vision && vision.checked),
      };
    }).filter((m) => m.id);

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
        llm.providers = body.providers;
        llm.models = body.models;
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

  function addProvider() {
    const sel = $("#provider-preset-select");
    const presetId = sel ? sel.value : "";
    const preset = llm.provider_presets.find((p) => p.id === presetId) || null;
    llm.providers.push({
      id: "provider_" + Date.now().toString(36),
      name: preset ? preset.name : "",
      base_url: preset ? preset.base_url : "",
      api_key: "",
    });
    renderProviders();
    renderModels();
  }

  function addModel() {
    llm.models.push({
      id: "model_" + Date.now().toString(36),
      name: "",
      provider: llm.providers.length ? llm.providers[0].id : "",
      model: "",
      vision: false,
    });
    renderModels();
    renderRoles();
  }

  function onSettingsClick(e) {
    const removeProvider = e.target.closest("[data-remove-provider]");
    if (removeProvider) {
      const idx = Number(removeProvider.dataset.removeProvider);
      llm.providers.splice(idx, 1);
      renderProviders();
      renderModels();
      return;
    }
    const removeModel = e.target.closest("[data-remove-model]");
    if (removeModel) {
      const idx = Number(removeModel.dataset.removeModel);
      llm.models.splice(idx, 1);
      renderModels();
      renderRoles();
      return;
    }
  }

  function onSettingsInput(e) {
    const providerRow = e.target.closest("[data-provider-idx]");
    if (providerRow) {
      const idx = Number(providerRow.dataset.providerIdx);
      const field = e.target.dataset.field;
      if (field && llm.providers[idx]) llm.providers[idx][field] = e.target.value;
      if (field === "id") syncModelProviderOptions();
      return;
    }
    const modelRow = e.target.closest("[data-model-idx]");
    if (modelRow) {
      const idx = Number(modelRow.dataset.modelIdx);
      const field = e.target.dataset.field;
      if (!llm.models[idx]) return;
      if (field === "vision") llm.models[idx].vision = e.target.checked;
      else if (field) llm.models[idx][field] = e.target.value;
      return;
    }
  }

  function init() {
    $("#save-settings-btn").addEventListener("click", saveSettings);
    $("#add-provider-btn").addEventListener("click", addProvider);
    $("#add-model-btn").addEventListener("click", addModel);
    const body = document.querySelector(".settings-body");
    body.addEventListener("click", onSettingsClick);
    body.addEventListener("input", onSettingsInput);
    loadSettings();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
