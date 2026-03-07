const dailyMinutesInput = document.getElementById("daily-minutes");
const refreshBtn = document.getElementById("refresh-btn");
const statusEl = document.getElementById("status");
const priorityListEl = document.getElementById("priority-list");

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSafeDailyMinutes() {
  const value = Number(dailyMinutesInput.value);
  if (!Number.isInteger(value) || value < 0) {
    return 120;
  }
  return Math.min(value, 1440);
}

function formatDate(dateValue) {
  if (!dateValue) {
    return "Not set";
  }
  const d = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    return "Not set";
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function scoreMarkup(components) {
  if (!components) {
    return '<div class="metric">Missing inputs for SPS</div>';
  }

  return `
    <div class="metric">SPS: ${components.sps.toFixed(2)}</div>
    <div class="metric">Urgency: ${components.urgency.toFixed(0)}</div>
    <div class="metric">Gap: ${components.knowledgeGap.toFixed(0)}</div>
    <div class="metric">Importance: ${components.importance.toFixed(0)}</div>
    <div class="metric">Forgetting: ${components.forgettingRisk.toFixed(0)}</div>
  `;
}

function buildItemMarkup(item) {
  const confidenceValue = item.confidence == null ? "" : item.confidence;
  const importanceValue = item.importance == null ? "" : item.importance;
  const examDateValue = item.examDate || item.dueDate || "";
  const lastReviewedValue = item.lastReviewedAt || "";
  const estimatedValue = item.estimatedTimeNeededMinutes == null ? "" : item.estimatedTimeNeededMinutes;

  return `
    <article class="priority-item" data-item-id="${item.courseworkItemId}">
      <div class="item-head">
        <strong>${escapeHtml(item.title)}</strong>
        <span class="pill">${escapeHtml(item.itemType)}</span>
      </div>

      <div class="course-line">
        <span class="swatch" style="background:${escapeHtml(item.courseColor)}"></span>
        <span>${escapeHtml(item.courseName)} · Due ${formatDate(item.dueDate)}</span>
      </div>

      <div class="recommend">Recommended today: ${item.recommendedMinutes} min</div>
      <div class="score-row">${scoreMarkup(item.components)}</div>

      <form class="priority-form">
        <div class="form-grid">
          <div>
            <label>Confidence (1-5)</label>
            <input name="confidence" type="number" min="1" max="5" step="1" value="${escapeHtml(confidenceValue)}" required />
          </div>
          <div>
            <label>Importance (1-5)</label>
            <input name="importance" type="number" min="1" max="5" step="1" value="${escapeHtml(importanceValue)}" required />
          </div>
          <div>
            <label>Exam Date</label>
            <input name="examDate" type="date" value="${escapeHtml(examDateValue)}" required />
          </div>
          <div>
            <label>Last Reviewed</label>
            <input name="lastReviewedAt" type="date" value="${escapeHtml(lastReviewedValue)}" required />
          </div>
          <div class="full">
            <label>Estimated Time Needed (minutes)</label>
            <input name="estimatedTimeNeededMinutes" type="number" min="1" step="1" value="${escapeHtml(estimatedValue)}" required />
          </div>
        </div>
        <button type="submit">Save Inputs</button>
        <div class="item-message" aria-live="polite"></div>
      </form>
    </article>
  `;
}

function attachFormHandlers() {
  const forms = priorityListEl.querySelectorAll(".priority-form");
  forms.forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const card = form.closest(".priority-item");
      const courseworkItemId = Number(card && card.dataset.itemId);
      const messageEl = form.querySelector(".item-message");

      const formData = new FormData(form);
      const payload = {
        courseworkItemId,
        confidence: Number(formData.get("confidence")),
        importance: Number(formData.get("importance")),
        examDate: String(formData.get("examDate") || "").trim(),
        lastReviewedAt: String(formData.get("lastReviewedAt") || "").trim(),
        estimatedTimeNeededMinutes: Number(formData.get("estimatedTimeNeededMinutes")),
      };

      messageEl.textContent = "Saving...";

      try {
        const response = await fetch("/api/priorities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || "Failed to save priority inputs");
        }

        messageEl.textContent = "Saved.";
        await loadPriorities();
      } catch (error) {
        messageEl.textContent = error.message || "Could not save right now.";
      }
    });
  });
}

function renderPriorities(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    priorityListEl.innerHTML = '<article class="card empty">No incomplete coursework items found. Add items in Planner first.</article>';
    return;
  }

  priorityListEl.innerHTML = items.map(buildItemMarkup).join("");
  attachFormHandlers();
}

async function loadPriorities() {
  const dailyMinutes = getSafeDailyMinutes();
  dailyMinutesInput.value = String(dailyMinutes);
  statusEl.textContent = "Loading priorities...";

  try {
    const response = await fetch(`/api/priorities?dailyMinutes=${dailyMinutes}&limit=5000`);
    if (!response.ok) {
      throw new Error("Failed to load priorities");
    }

    const data = await response.json();
    renderPriorities(data);

    const scoredCount = (data.items || []).filter((item) => item.components).length;
    statusEl.textContent = `Loaded ${data.items.length} item(s). ${scoredCount} item(s) currently have complete SPS inputs.`;
  } catch (error) {
    priorityListEl.innerHTML = '<article class="card empty">Could not load priorities right now.</article>';
    statusEl.textContent = "Unable to load priorities.";
  }
}

refreshBtn.addEventListener("click", loadPriorities);
dailyMinutesInput.addEventListener("change", loadPriorities);

loadPriorities();
