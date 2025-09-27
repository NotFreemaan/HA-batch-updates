// Helper: resolve an icon URL for an add-on
function getAddonIconUrl(addon) {
  // Common fields you might encounter from add-on sources:
  const candidates = [
    addon?.icon_url,
    addon?.icon,         // some sources use 'icon'
    addon?.images?.icon, // or nested
  ].filter(Boolean);

  if (candidates.length && String(candidates[0]).trim()) {
    return candidates[0];
  }
  // Fallback to our packaged SVG ONLY when missing
  return "/ha_batch_updates_static/update.svg";
}

// Example render (adapt for Lit/React/etc.)
function renderAddonCard(addon) {
  const iconUrl = getAddonIconUrl(addon);

  // Create <img> with error fallback (handles broken remote URLs)
  const img = document.createElement("img");
  img.className = "addon-icon";
  img.src = iconUrl;
  img.alt = "";
  img.width = 32;
  img.height = 32;
  img.referrerPolicy = "no-referrer";

  img.onerror = () => {
    img.onerror = null; // prevent loops
    img.src = "/ha_batch_updates_static/update.svg";
  };

  const card = document.createElement("div");
  card.className = "addon-card";
  card.appendChild(img);

  const title = document.createElement("div");
  title.className = "addon-title";
  title.textContent = addon?.name ?? "Unknown add-on";
  card.appendChild(title);

  return card;
}
