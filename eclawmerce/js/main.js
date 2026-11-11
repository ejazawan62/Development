// eClawmerce storefront. Edit WHATSAPP, CURRENCY and PRODUCTS to match your real shop.
const WHATSAPP = "923000000000";
const CURRENCY = "Rs";

const CATEGORIES = [
  { id: "all", name: "All", emoji: "🛍️" },
  { id: "electronics", name: "Electronics", emoji: "🎧" },
  { id: "fashion", name: "Fashion", emoji: "👟" },
  { id: "home", name: "Home", emoji: "🛋️" },
  { id: "beauty", name: "Beauty", emoji: "💄" },
  { id: "accessories", name: "Accessories", emoji: "⌚" },
];

// Sample products. Replace with your real catalogue.
const PRODUCTS = [
  { id: 1, name: "Wireless Earbuds Pro", cat: "electronics", price: 4999, was: 7499, emoji: "🎧", bg: "#FFE8DC" },
  { id: 2, name: "Smart Watch S2", cat: "accessories", price: 8999, was: 11999, emoji: "⌚", bg: "#E5ECFF" },
  { id: 3, name: "Everyday Sneakers", cat: "fashion", price: 5499, emoji: "👟", bg: "#E8F6EE" },
  { id: 4, name: "Bluetooth Speaker", cat: "electronics", price: 3999, was: 4999, emoji: "🔊", bg: "#FFF1D6" },
  { id: 5, name: "Cotton Hoodie", cat: "fashion", price: 2999, emoji: "🧥", bg: "#F1E6FF" },
  { id: 6, name: "Ceramic Mug Set", cat: "home", price: 1499, emoji: "☕", bg: "#FFE3E5" },
  { id: 7, name: "Skincare Kit", cat: "beauty", price: 3499, was: 4299, emoji: "🧴", bg: "#E3F5F8" },
  { id: 8, name: "Desk Lamp LED", cat: "home", price: 2499, emoji: "💡", bg: "#FFF6CC" },
];

const $ = (s) => document.querySelector(s);
const fmt = (n) => `${CURRENCY} ${n.toLocaleString("en-US")}`;
let activeCat = "all";

// Cart persists per browser; fall back to memory if storage is blocked.
let cart = {};
try { cart = JSON.parse(localStorage.getItem("eclaw-cart")) || {}; } catch { cart = {}; }
const saveCart = () => { try { localStorage.setItem("eclaw-cart", JSON.stringify(cart)); } catch {} };

function renderCats() {
  $("#cats").innerHTML = CATEGORIES.map((c) =>
    `<button class="cat${c.id === activeCat ? " active" : ""}" data-cat="${c.id}"><span class="emoji">${c.emoji}</span>${c.name}</button>`
  ).join("");
}

function renderProducts() {
  const q = $("#search").value.trim().toLowerCase();
  let list = PRODUCTS.filter((p) =>
    (activeCat === "all" || p.cat === activeCat) && p.name.toLowerCase().includes(q)
  );
  const sort = $("#sort").value;
  if (sort === "low") list = [...list].sort((a, b) => a.price - b.price);
  if (sort === "high") list = [...list].sort((a, b) => b.price - a.price);

  $("#empty").hidden = list.length > 0;
  $("#products").innerHTML = list.map((p) => {
    const off = p.was ? Math.round((1 - p.price / p.was) * 100) : 0;
    return `<article class="product">
      <div class="thumb" style="background:${p.bg}">${off ? `<span class="badge">-${off}%</span>` : ""}${p.emoji}</div>
      <div class="pinfo">
        <span class="pcat">${CATEGORIES.find((c) => c.id === p.cat).name}</span>
        <h3 class="pname">${p.name}</h3>
        <div class="price"><strong>${fmt(p.price)}</strong>${p.was ? `<s>${fmt(p.was)}</s>` : ""}</div>
        <button class="btn btn-primary add" data-add="${p.id}">Add to cart</button>
      </div>
    </article>`;
  }).join("");
}

function renderCart() {
  const ids = Object.keys(cart);
  let total = 0, count = 0;
  $("#cartItems").innerHTML = ids.length ? ids.map((id) => {
    const p = PRODUCTS.find((x) => x.id == id);
    if (!p) return "";
    total += p.price * cart[id];
    count += cart[id];
    return `<div class="line">
      <div class="line-thumb" style="background:${p.bg}">${p.emoji}</div>
      <div class="line-info"><strong>${p.name}</strong>${fmt(p.price)}</div>
      <div class="qty"><button data-dec="${id}" aria-label="Remove one">−</button>${cart[id]}<button data-inc="${id}" aria-label="Add one">+</button></div>
    </div>`;
  }).join("") : `<p class="empty">Your cart is empty.</p>`;
  $("#cartTotal").textContent = fmt(total);
  $("#cartCount").textContent = count;
  saveCart();
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 1800);
}

function setDrawer(open) {
  $("#drawer").classList.toggle("open", open);
  $("#drawer").setAttribute("aria-hidden", String(!open));
  $("#overlay").classList.toggle("show", open);
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-cat],[data-add],[data-inc],[data-dec]");
  if (!el) return;
  if (el.dataset.cat) { activeCat = el.dataset.cat; renderCats(); renderProducts(); }
  if (el.dataset.add) { cart[el.dataset.add] = (cart[el.dataset.add] || 0) + 1; renderCart(); toast("Added to cart"); }
  if (el.dataset.inc) { cart[el.dataset.inc]++; renderCart(); }
  if (el.dataset.dec) { if (--cart[el.dataset.dec] <= 0) delete cart[el.dataset.dec]; renderCart(); }
});

$("#search").addEventListener("input", () => {
  renderProducts();
  if ($("#search").value) document.getElementById("shop").scrollIntoView({ behavior: "smooth" });
});
$("#sort").addEventListener("change", renderProducts);
$("#cartBtn").addEventListener("click", () => setDrawer(true));
$("#closeCart").addEventListener("click", () => setDrawer(false));
$("#overlay").addEventListener("click", () => setDrawer(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setDrawer(false); });

$("#checkout").addEventListener("click", () => {
  const lines = Object.keys(cart).map((id) => {
    const p = PRODUCTS.find((x) => x.id == id);
    return p ? `• ${p.name} × ${cart[id]} = ${fmt(p.price * cart[id])}` : "";
  }).filter(Boolean);
  if (!lines.length) return toast("Your cart is empty");
  const msg = `Hi eClawmerce, I'd like to order:\n${lines.join("\n")}\nTotal: ${$("#cartTotal").textContent}`;
  window.open(`https://wa.me/${WHATSAPP}?text=${encodeURIComponent(msg)}`, "_blank");
});

$("#newsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  e.target.reset();
  toast("Thanks for subscribing!");
});

$("#year").textContent = new Date().getFullYear();
renderCats();
renderProducts();
renderCart();
