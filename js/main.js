// Sample packages — keep in sync with the cards in index.html.
const PLANS = [
  { name: "Basic", mbps: 10, price: 2500 },
  { name: "Home", mbps: 20, price: 3500 },
  { name: "Family", mbps: 50, price: 5500 },
  { name: "Pro", mbps: 100, price: 8500 },
  { name: "Business Plus", mbps: 200, price: 20000 },
];
const WHATSAPP = "923000000000";
const GAUGE_MAX = 200;
const ARC_LENGTH = 301.6;

const $ = (id) => document.getElementById(id);
const rupees = (n) => "Rs " + n.toLocaleString("en-PK");

// Mobile menu
const nav = $("nav");
const toggle = $("nav-toggle");
toggle.addEventListener("click", () => {
  const open = nav.classList.toggle("open");
  toggle.setAttribute("aria-expanded", open);
});
nav.addEventListener("click", (e) => {
  if (e.target.closest("a")) { nav.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); }
});

// Plan finder: about 5 Mbps per person plus headroom for heavy uses
function recommend() {
  const people = +$("people").value;
  $("people-out").textContent = people;
  const extra = [...document.querySelectorAll(".uses input:checked")].reduce((s, el) => s + +el.value, 0);
  const need = people * 5 + extra;
  const plan = PLANS.find((p) => p.mbps >= need) || PLANS[PLANS.length - 1];
  const label = `${plan.name} ${plan.mbps} Mbps`;
  $("rec-plan").textContent = label;
  $("rec-price").textContent = `${rupees(plan.price)} / month`;
  $("gauge-readout").textContent = plan.mbps;
  $("gauge-fill").setAttribute("stroke-dashoffset", (ARC_LENGTH * (1 - plan.mbps / GAUGE_MAX)).toFixed(1));
  $("rec-cta").dataset.plan = label;
}
$("finder").addEventListener("input", recommend);
$("finder").addEventListener("submit", (e) => e.preventDefault());
recommend();

// Home / Business tabs
const tabs = [$("tab-home"), $("tab-biz")];
tabs.forEach((tab) => tab.addEventListener("click", () => {
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute("aria-selected", on);
    $(t.getAttribute("aria-controls")).hidden = !on;
  });
}));

// Any "choose" button pre-selects the package in the contact form
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-plan]");
  if (!btn) return;
  const select = $("lead-plan");
  const match = [...select.options].find((o) => o.text === btn.dataset.plan);
  if (match) select.value = match.text;
});

// Coverage check against the served areas list
const AREAS = [...document.querySelectorAll(".cities li")].map((li) => ({
  city: li.firstChild.textContent.trim(),
  areas: li.querySelector(".area").textContent.split("·").map((a) => a.trim()),
}));
$("check-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("area").value.trim().toLowerCase();
  const out = $("check-result");
  if (!q) return;
  const hit = AREAS.find(({ city, areas }) =>
    q.includes(city.toLowerCase()) || areas.some((a) => q.includes(a.toLowerCase())));
  out.hidden = false;
  if (hit) {
    out.className = "status ok";
    out.textContent = `Good news: DPIS serves ${hit.city}. Send a request below and we'll confirm your exact street.`;
  } else {
    out.className = "status no";
    out.textContent = "We don't list that area yet. Send a request below anyway: we expand to streets with enough interest.";
  }
});

// Lead form: compose a WhatsApp message (works without a server)
$("lead-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = (id) => $(id).value.trim();
  const text = [
    "New connection request (DPIS website)",
    `Name: ${v("lead-name")}`,
    `Mobile: ${v("lead-phone")}`,
    `City: ${v("lead-city")}`,
    `Package: ${v("lead-plan")}`,
    `Address: ${v("lead-address")}`,
  ].join("\n");
  $("form-message").textContent = text;
  $("form-wa").href = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`;
  $("form-done").hidden = false;
});

$("year").textContent = new Date().getFullYear();
