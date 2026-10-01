/* Shared engine for the two card-check forms: / (playground) and /upload
 * (partner form embedded in Rocketlane).
 *
 * Both pages run the same flow — pick a card type, drop a file, POST it to
 * /api/card-check and stream the analysis back over SSE — and this file owns
 * that flow once. The pages differ only in chrome (curl preview, raw event
 * log, Slack toggle, result layout), and those differences arrive here as the
 * config passed to CardCheckForm.create():
 *
 *   labels                 { idle, busy } — submit-button text states
 *   dropText               { virtual, physical } — dropzone captions (HTML)
 *   getProjectId()         the projectId to submit (input field or URL param)
 *   isReady()              extra submit gate beyond file validity (optional)
 *   missingProjectMessage  error shown if submit happens with no projectId
 *   formatError(msg)       page-specific error phrasing (optional)
 *   appendFields(formData) extra multipart fields (optional)
 *   decorateDelivery(d)    tweak the delivery payload before /api/card-deliver
 *   renderResult(payload)  page-specific result DOM for the 'complete' event
 *   onEvent(type, payload) every parsed SSE frame (raw log) (optional)
 *   onStateChange(state)   after any form-state change (curl preview) (optional)
 *   onStreamStart() / onStreamEnd()  around each submission (optional)
 *
 * The engine finds its elements by the ids the two pages already share;
 * optional chrome (agent output, elapsed timer, back-of-card field) is
 * simply absent on pages that don't render it.
 */

(() => {
  'use strict';

  // The server accepts .png for physical fronts and backs (PHYSICAL_EXTS in
  // api/card-check.js) — this is the single client-side mirror of that set.
  const PHYSICAL_EXT_RE = /\.(ai|eps|png)$/i;
  const VIRTUAL_MAX_BYTES = 10 * 1024 * 1024;
  const PHYSICAL_MAX_BYTES = 25 * 1024 * 1024;

  const VIRTUAL_ACCEPT = 'image/png';
  const PHYSICAL_ACCEPT = '.ai,.eps,.png,application/postscript,application/illustrator,image/png';

  const escapeHtml = (value) => {
    const d = document.createElement('div');
    d.textContent = String(value);
    return d.innerHTML;
  };

  const create = (opts) => {
    const $ = (id) => document.getElementById(id);

    const form = $('upload-form');
    const submitBtn = $('submit-btn');
    const submitLabel = submitBtn.querySelector('span') || submitBtn;
    const cardTypeGroup = $('card-type-toggle');
    const dropZone = $('drop-zone');
    const fileInput = $('file-input');
    const dropZoneText = $('drop-zone-text');
    const previewSection = $('preview-section');
    const previewImg = $('preview-img');
    const previewMeta = $('preview-meta');
    const validationChecks = $('validation-checks');
    const backFileField = $('back-file-field');
    const backDropZone = $('back-drop-zone');
    const backFileInput = $('back-file-input');
    const backPreviewMeta = $('back-preview-meta');
    const backValidationChecks = $('back-validation-checks');
    const progressSection = $('progress-section');
    const progressSteps = $('progress-steps');
    const agentOutput = $('agent-output');
    const resultSection = $('result-section');
    const errorBanner = $('error-banner');
    const elapsedEl = $('elapsed-timer');

    const state = {
      cardType: 'virtual',
      selectedFile: null,
      selectedBackFile: null,
      isFileValid: false,
      isBackValid: true, // no back file selected, or a valid one
    };

    let stepElements = {};
    let elapsedTimer = null;

    /* ── Form state ──────────────────────────────────────── */

    const updateSubmitState = () => {
      const frontOk = Boolean(state.selectedFile && state.isFileValid);
      const backOk = state.cardType !== 'physical' || !state.selectedBackFile || state.isBackValid;
      const extraOk = opts.isReady ? opts.isReady() : true;
      submitBtn.disabled = !(frontOk && backOk && extraOk);
    };

    const notify = () => {
      updateSubmitState();
      if (opts.onStateChange) opts.onStateChange(state);
    };

    const renderChecks = (container, checks) => {
      container.innerHTML = checks.map((c) => `
        <div class="val-check ${c.pass ? 'pass' : 'fail'}">
          <span class="icon">${c.pass ? '&#10003;' : '&#10007;'}</span>
          <span>${c.label}</span>
        </div>
      `).join('');
      container.classList.add('visible');
    };

    /* ── Card type ───────────────────────────────────────── */

    const setCardType = (next) => {
      if (next !== 'virtual' && next !== 'physical') return;
      state.cardType = next;

      if (next === 'physical') {
        fileInput.setAttribute('accept', PHYSICAL_ACCEPT);
        dropZoneText.innerHTML = opts.dropText.physical;
        if (backFileField) backFileField.style.display = '';
      } else {
        fileInput.setAttribute('accept', VIRTUAL_ACCEPT);
        dropZoneText.innerHTML = opts.dropText.virtual;
        if (backFileField) {
          backFileField.style.display = 'none';
          state.selectedBackFile = null;
          state.isBackValid = true;
          backFileInput.value = '';
          backPreviewMeta.innerHTML = '';
          backValidationChecks.innerHTML = '';
          backValidationChecks.classList.remove('visible');
          backDropZone.classList.remove('has-file');
        }
      }

      // Re-validate an already-selected front file under the new rules.
      if (state.selectedFile) handleFile(state.selectedFile);
      notify();
    };

    for (const radio of cardTypeGroup.querySelectorAll('input[type="radio"]')) {
      if (radio.checked) state.cardType = radio.value;
      radio.addEventListener('change', () => {
        if (radio.checked) setCardType(radio.value);
      });
    }

    /* ── File validation ─────────────────────────────────── */

    const finishFrontChecks = (checks) => {
      renderChecks(validationChecks, checks);
      state.isFileValid = checks.every((c) => c.pass);
      dropZone.classList.toggle('has-file', state.isFileValid);
      notify();
    };

    const handleFile = (file) => {
      state.selectedFile = file;
      previewSection.classList.add('visible');

      if (state.cardType === 'physical') {
        const extOk = PHYSICAL_EXT_RE.test(file.name || '');
        const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
        const checks = [
          { label: 'File extension is .ai, .eps, or .png', pass: extOk },
          { label: 'File size under 25 MB', pass: file.size < PHYSICAL_MAX_BYTES },
        ];
        const isPng = /\.png$/i.test(file.name || '') || file.type === 'image/png';

        if (isPng && extOk) {
          // PNG physical submissions can be decoded in-browser — show
          // preview + dimensions like the virtual path.
          previewImg.style.display = '';
          const url = URL.createObjectURL(file);
          previewImg.src = url;
          const img = new Image();
          img.onload = () => {
            previewMeta.innerHTML = `
              <span>${escapeHtml(file.name)}</span>
              <span>${img.naturalWidth} &times; ${img.naturalHeight} px</span>
              <span>${sizeMB} MB</span>
            `;
            checks.push({
              label: 'PNG dimensions 1536 x 969',
              pass: img.naturalWidth === 1536 && img.naturalHeight === 969,
            });
            finishFrontChecks(checks);
          };
          img.src = url;
          return;
        }

        // Vector (.ai/.eps) files can't be decoded in-browser: ext + size only.
        previewImg.removeAttribute('src');
        previewImg.style.display = 'none';
        previewMeta.innerHTML = `
          <span>${escapeHtml(file.name)}</span>
          <span>${sizeMB} MB</span>
        `;
        finishFrontChecks(checks);
        return;
      }

      // Virtual: decode the raster to verify the exact dimensions.
      previewImg.style.display = '';
      const url = URL.createObjectURL(file);
      previewImg.src = url;
      const img = new Image();
      img.onload = () => {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
        previewMeta.innerHTML = `
          <span>${img.naturalWidth} &times; ${img.naturalHeight} px</span>
          <span>${sizeMB} MB</span>
          <span>${escapeHtml(file.type)}</span>
        `;
        finishFrontChecks([
          { label: 'PNG format', pass: file.type === 'image/png' },
          { label: 'Dimensions 1536 x 969', pass: img.naturalWidth === 1536 && img.naturalHeight === 969 },
          { label: 'File size under 10 MB', pass: file.size < VIRTUAL_MAX_BYTES },
        ]);
      };
      img.src = url;
    };

    const handleBackFile = (file) => {
      state.selectedBackFile = file;
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
      backPreviewMeta.innerHTML = `
        <span>${escapeHtml(file.name)}</span>
        <span>${sizeMB} MB</span>
      `;
      const checks = [
        { label: 'File extension is .ai, .eps, or .png', pass: PHYSICAL_EXT_RE.test(file.name || '') },
        { label: 'File size under 25 MB', pass: file.size < PHYSICAL_MAX_BYTES },
      ];
      renderChecks(backValidationChecks, checks);
      state.isBackValid = checks.every((c) => c.pass);
      backDropZone.classList.toggle('has-file', state.isBackValid);
      notify();
    };

    const wireDropZone = (zone, input, onFile) => {
      if (!zone || !input) return;
      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
        if (e.dataTransfer.files.length) onFile(e.dataTransfer.files[0]);
      });
      input.addEventListener('change', () => {
        if (input.files.length) onFile(input.files[0]);
      });
    };

    wireDropZone(dropZone, fileInput, handleFile);
    wireDropZone(backDropZone, backFileInput, handleBackFile);

    /* ── Progress + results ──────────────────────────────── */

    const iconFor = (status) => {
      if (status === 'done') return '&#10003;';
      if (status === 'warn') return '&#9888;';
      if (status === 'error') return '&#10007;';
      return '<span class="spinner"></span>';
    };

    const upsertStep = (stepId, message, status) => {
      if (stepElements[stepId]) {
        const el = stepElements[stepId];
        el.className = `step ${status}`;
        el.querySelector('.step-msg').textContent = message;
        el.querySelector('.step-icon').innerHTML = iconFor(status);
      } else {
        const el = document.createElement('div');
        el.className = `step ${status}`;
        el.innerHTML = `
          <span class="step-icon">${iconFor(status)}</span>
          <span class="step-msg">${escapeHtml(message)}</span>
        `;
        progressSteps.appendChild(el);
        stepElements[stepId] = el;
      }
    };

    const showError = (msg) => {
      errorBanner.textContent = opts.formatError ? opts.formatError(msg) : msg;
      errorBanner.classList.add('visible');
    };

    const startElapsed = () => {
      if (!elapsedEl) return;
      const startedAt = Date.now();
      elapsedEl.textContent = '0:00 elapsed · typically 2–3 min';
      elapsedTimer = setInterval(() => {
        const s = Math.floor((Date.now() - startedAt) / 1000);
        const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        elapsedEl.textContent = `${mmss} elapsed · typically 2–3 min`;
      }, 1000);
    };

    const stopElapsed = () => {
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = null;
    };

    const triggerDelivery = async (delivery) => {
      const label = delivery.slackDelivery === false ? 'Delivering (Slack off)...' : 'Posting to Slack...';
      upsertStep('slack_deliver', label, 'pending');
      try {
        const res = await fetch('/api/card-deliver', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(delivery),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Delivery failed');

        const slack = data.results.slack;
        if (slack === 'ok') {
          upsertStep('slack_deliver', 'Posted to Slack', 'done');
        } else if (slack === 'skipped: slack delivery disabled by request') {
          upsertStep('slack_deliver', 'Slack delivery off — PDF report only', 'done');
        } else if (slack === 'skipped') {
          upsertStep('slack_deliver', 'Slack not configured — skipping', 'done');
        } else {
          upsertStep('slack_deliver', slack, 'warn');
        }
      } catch (err) {
        upsertStep('slack_deliver', `Delivery error: ${err.message}`, 'warn');
      }
    };

    /* ── Rich result detail ──────────────────────────────── */
    // Renders the structured result (lib/result-schema.js) that rides the
    // 'complete' event into #result-detail, when the page provides one.
    // opts.resultDetail: 'full' (default) or 'compact' — compact shows only
    // failing/warning checks plus a rollup line, for the small iframe.

    const resultDetail = $('result-detail');

    const STATUS_META = {
      pass: ['✓', 'pass', 'Pass'],
      fail: ['✗', 'fail', 'Fail'],
      warning: ['⚠', 'warning', 'Warning'],
      unverified: ['◌', 'unverified', 'Unverified'],
      not_submitted: ['—', 'unverified', 'Not submitted'],
      estimated: ['≈', 'warning', 'Estimated'],
    };
    const OUTCOME_META = {
      approved: ['success', 'Approved'],
      approved_with_notes: ['warning', 'Approved with notes'],
      requires_changes: ['error', 'Requires changes'],
    };

    const pngObjectUrl = (file) => {
      if (!file) return null;
      const isPng = /\.png$/i.test(file.name || '') || file.type === 'image/png';
      return isPng ? URL.createObjectURL(file) : null;
    };

    const checkRow = (check, markerNo) => {
      const [icon, cls, label] = STATUS_META[check.status] || STATUS_META.unverified;
      const badge = markerNo ? `<span class="rr-no">${markerNo}</span>` : '';
      const severity = check.severity === 'blocker' && (check.status === 'fail' || check.status === 'warning')
        ? '<span class="rr-sev">blocker</span>' : '';
      const reason = check.reason_code && check.reason_code !== 'other'
        ? `<span class="rr-reason">${escapeHtml(check.reason_code)}</span>` : '';
      return `
        <div class="rr-check ${cls}" data-check="${escapeHtml(check.id)}">
          <span class="rr-icon" title="${label}">${icon}</span>
          <span class="rr-body">
            <span class="rr-name">${escapeHtml(check.name)} ${badge}${severity}${reason}</span>
            ${check.notes ? `<span class="rr-notes">${escapeHtml(check.notes)}</span>` : ''}
          </span>
        </div>`;
    };

    const renderResultDetail = (result, payload) => {
      if (!resultDetail) return;
      resultDetail.innerHTML = '';
      if (!result || typeof result !== 'object' || !Array.isArray(result.checks)) return;

      const compact = opts.resultDetail === 'compact';
      const parts = [];

      // Top row: three-state outcome, counts, copyable run id.
      const [pillCls, pillLabel] = OUTCOME_META[result.outcome] || ['plain', result.outcome || 'Result'];
      const counts = result.counts || {};
      const countBits = ['pass', 'fail', 'warning', 'unverified']
        .filter((k) => counts[k])
        .map((k) => `${counts[k]} ${STATUS_META[k][2].toLowerCase()}`)
        .join(' · ');
      parts.push(`
        <div class="rr-toprow">
          <span class="cc-pill ${pillCls}">${escapeHtml(pillLabel)}</span>
          ${countBits ? `<span class="rr-counts">${countBits}</span>` : ''}
          ${result.run_id ? `<button type="button" class="rr-copy" data-copy="${escapeHtml(result.run_id)}">run ${escapeHtml(result.run_id)} ⧉</button>` : ''}
        </div>`);

      // Annotated preview: numbered dots over the art the user just uploaded.
      // Fractional {x, y} marker coordinates map straight to percentages.
      const markers = result.checks.filter((c) => c.marker && (c.marker.side || 'front') === 'front');
      const markerNos = new Map(markers.map((c, i) => [c.id, i + 1]));
      const frontUrl = pngObjectUrl(state.selectedFile);
      if (frontUrl && markers.length) {
        const dots = markers.map((c) => {
          const [, cls] = STATUS_META[c.status] || STATUS_META.unverified;
          return `<button type="button" class="rr-dot ${cls}" data-check="${escapeHtml(c.id)}"
            style="left: ${(c.marker.x * 100).toFixed(2)}%; top: ${(c.marker.y * 100).toFixed(2)}%"
            aria-label="Marker ${markerNos.get(c.id)}: ${escapeHtml(c.name)}">${markerNos.get(c.id)}</button>`;
        }).join('');
        parts.push(`
          <div class="rr-preview">
            <img src="${frontUrl}" alt="Submitted card art with issue markers">
            ${dots}
          </div>`);
      }

      // Check list. Compact keeps the actionable rows; full groups by category.
      const actionable = result.checks.filter((c) => c.status === 'fail' || c.status === 'warning');
      if (compact) {
        if (actionable.length) {
          parts.push(`<div class="rr-group">${actionable.map((c) => checkRow(c, markerNos.get(c.id))).join('')}</div>`);
        }
        const rest = result.checks.length - actionable.length;
        if (rest > 0) {
          parts.push(`<div class="rr-rollup">${rest} more check${rest === 1 ? '' : 's'} passed or were not assessed — full detail in the PDF report.</div>`);
        }
      } else {
        const groups = new Map();
        for (const c of result.checks) {
          const key = c.category || 'Other';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(c);
        }
        for (const [category, checks] of groups) {
          parts.push(`
            <div class="rr-group">
              <h4>${escapeHtml(category)}</h4>
              ${checks.map((c) => checkRow(c, markerNos.get(c.id))).join('')}
            </div>`);
        }
      }

      // Deterministic tech checks, with their measurements.
      if (!compact && Array.isArray(result.tech_checks) && result.tech_checks.length) {
        parts.push(`
          <div class="rr-group">
            <h4>Technical checks</h4>
            ${result.tech_checks.map((t) => {
              const [icon, cls, label] = STATUS_META[t.status] || STATUS_META.unverified;
              const dims = t.actual != null ? `<span class="rr-reason">${escapeHtml(String(t.actual))}${t.required != null ? ` / needs ${escapeHtml(String(t.required))}` : ''}</span>` : '';
              return `
                <div class="rr-check ${cls}">
                  <span class="rr-icon" title="${label}">${icon}</span>
                  <span class="rr-body">
                    <span class="rr-name">${escapeHtml(t.side ? `${t.side} · ${t.id}` : t.id)} ${dims}</span>
                    ${t.note ? `<span class="rr-notes">${escapeHtml(t.note)}</span>` : ''}
                  </span>
                </div>`;
            }).join('')}
          </div>`);
      }

      // Extracted colors.
      if (!compact && result.colors) {
        const swatches = Object.entries(result.colors)
          .filter(([, c]) => c && c.hex)
          .map(([role, c]) => `<span class="rr-swatch"><i style="background: ${escapeHtml(c.hex)}"></i>${escapeHtml(role)} ${escapeHtml(c.hex)}</span>`)
          .join('');
        if (swatches) parts.push(`<div class="rr-group"><h4>Extracted colors</h4><div class="rr-swatches">${swatches}</div></div>`);
      }

      // The structured-result endpoint needs the shared secret, so it is
      // offered as a copyable curl, never a naked link (it 401s in a browser).
      if (!compact && payload.resultUrl) {
        const curl = `curl -H "Authorization: Bearer $CARD_ART_CHECKER_SECRET" ${payload.resultUrl}`;
        parts.push(`
          <div class="rr-group">
            <h4>Fetch this result</h4>
            <div class="rr-curl"><button type="button" class="rr-copy" data-copy="${escapeHtml(curl)}">Copy</button><code>${escapeHtml(curl)}</code></div>
          </div>`);
      }

      resultDetail.innerHTML = `<div class="rr-detail">${parts.join('')}</div>`;
    };

    if (resultDetail) {
      resultDetail.addEventListener('click', async (e) => {
        const copy = e.target.closest('.rr-copy');
        if (copy) {
          try {
            await navigator.clipboard.writeText(copy.dataset.copy);
            const original = copy.textContent;
            copy.textContent = 'Copied';
            setTimeout(() => { copy.textContent = original; }, 1400);
          } catch { /* clipboard unavailable */ }
          return;
        }
        const dot = e.target.closest('.rr-dot');
        if (dot) {
          const row = resultDetail.querySelector(`.rr-check[data-check="${CSS.escape(dot.dataset.check)}"]`);
          if (row) {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.classList.add('flash');
            setTimeout(() => row.classList.remove('flash'), 1600);
          }
        }
      });
      // Hovering a check row lights up its dot on the preview, and vice versa.
      resultDetail.addEventListener('mouseover', (e) => {
        const el = e.target.closest('[data-check]');
        if (!el) return;
        for (const twin of resultDetail.querySelectorAll(`[data-check="${CSS.escape(el.dataset.check)}"]`)) {
          twin.classList.add('active');
        }
      });
      resultDetail.addEventListener('mouseout', (e) => {
        const el = e.target.closest('[data-check]');
        if (!el) return;
        for (const twin of resultDetail.querySelectorAll(`[data-check="${CSS.escape(el.dataset.check)}"]`)) {
          twin.classList.remove('active');
        }
      });
    }

    const handleEvent = (type, payload) => {
      switch (type) {
        case 'progress':
          upsertStep(payload.step, payload.message, payload.status);
          break;
        case 'agent_delta':
          if (!agentOutput) break;
          agentOutput.classList.add('visible');
          agentOutput.insertAdjacentText('beforeend', payload.text);
          agentOutput.scrollTop = agentOutput.scrollHeight;
          break;
        case 'agent_tool': {
          if (!agentOutput) break;
          agentOutput.classList.add('visible');
          const badge = document.createElement('div');
          badge.innerHTML = `<span class="tool-badge">${escapeHtml(payload.tool || 'tool')}${payload.command ? ': ' + escapeHtml(payload.command) : ''}</span>`;
          agentOutput.appendChild(badge);
          agentOutput.scrollTop = agentOutput.scrollHeight;
          break;
        }
        case 'complete':
          opts.renderResult(payload);
          renderResultDetail(payload.result, payload);
          // tabindex="-1" in the markup makes the card focusable, so the
          // outcome is announced and the keyboard lands on it.
          resultSection.focus();
          // The API is the arbiter of Slack delivery — an opted-out run still
          // exercises /api/card-deliver, which records the skip.
          if (payload.delivery) {
            triggerDelivery(opts.decorateDelivery ? opts.decorateDelivery(payload.delivery) : payload.delivery);
          }
          break;
        case 'error':
          showError(payload.message);
          break;
      }
    };

    /* ── Submit ──────────────────────────────────────────── */

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submitBtn.disabled) return;

      const projectId = String(opts.getProjectId() || '').trim();
      if (!projectId) {
        showError(opts.missingProjectMessage || 'Missing projectId.');
        return;
      }

      submitBtn.disabled = true;
      submitLabel.textContent = opts.labels.busy;
      progressSection.classList.add('visible');
      errorBanner.classList.remove('visible');
      resultSection.classList.remove('visible');
      progressSteps.innerHTML = '';
      stepElements = {};
      if (resultDetail) resultDetail.innerHTML = '';
      if (agentOutput) {
        agentOutput.innerHTML = '';
        agentOutput.classList.remove('visible');
      }
      startElapsed();
      if (opts.onStreamStart) opts.onStreamStart();

      const formData = new FormData();
      formData.append('cardType', state.cardType);
      formData.append('file', state.selectedFile);
      formData.append('projectId', projectId);
      if (state.cardType === 'physical' && state.selectedBackFile) {
        formData.append('backFile', state.selectedBackFile);
      }
      if (opts.appendFields) opts.appendFields(formData);

      try {
        const response = await fetch(opts.endpoint || '/api/card-check', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || `Server error: ${response.status}`);
        }

        // Manual SSE parse: EventSource can't POST multipart, so read the
        // stream and split it into `event: X\ndata: Y` frames ourselves.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop(); // keep the incomplete frame
          for (const frame of frames) {
            const match = frame.match(/^event: (\w+)\ndata: (.+)$/s);
            if (!match) continue;
            try {
              const payload = JSON.parse(match[2]);
              if (opts.onEvent) opts.onEvent(match[1], payload);
              handleEvent(match[1], payload);
            } catch { /* skip malformed frame */ }
          }
        }
      } catch (err) {
        showError(err.message);
      } finally {
        // Always restore the button — a stream that dies without a terminal
        // frame (function timeout, dropped connection) must not strand the
        // form on its busy label.
        stopElapsed();
        submitLabel.textContent = opts.labels.idle;
        updateSubmitState();
        if (opts.onStreamEnd) opts.onStreamEnd();
      }
    });

    updateSubmitState();

    return { state, refresh: notify, upsertStep, showError };
  };

  window.CardCheckForm = { create, escapeHtml };
})();
