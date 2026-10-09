const SITE = "https://ici.radio-canada.ca";
// `hour` is when the show airs; the time in the episode data is not reliable.
const SHOWS = [
  { name: "Téléjournal midi", path: "/tele/le-telejournal-midi/site/episodes", hour: 12, color: "#039be5" },
  { name: "Téléjournal 18 h", path: "/tele/le-telejournal-18h/site/episodes", hour: 18, color: "#d50000" },
];
const FIRST_HOUR = 6, LAST_HOUR = 22;

// The pages embed their data as `window._rcState_ = {...}`.
function readState(html) {
  const start = html.indexOf("window._rcState_");
  const eq = html.indexOf("=", start) + 1;
  const end = html.indexOf("</script>", eq);
  return JSON.parse(html.slice(eq, end).trim().replace(/;$/, ""));
}

async function getEpisodes(show) {
  const html = await (await fetch(SITE + show.path)).text();
  const state = readState(html);
  return state.pages.pages[show.path].data.lineup.items.map((ep) => ({ ...ep, show }));
}

async function getMediaId(episodeUrl) {
  const html = await (await fetch(SITE + episodeUrl)).text();
  return html.match(/"mediaId":"(\d+)"/)[1];
}

// The validation API has no CORS headers, but supports JSONP.
function getStreamUrl(mediaId) {
  return new Promise((resolve, reject) => {
    const cb = "rc_" + mediaId;
    const s = document.createElement("script");
    window[cb] = (data) => { delete window[cb]; s.remove();
      data.url ? resolve(data.url.split("?")[0]) : reject(new Error(data.message || "Pas de flux")); };
    s.onerror = () => reject(new Error("Erreur réseau"));
    s.src = "https://services.radio-canada.ca/media/validation/v2/?appCode=medianet&idMedia=" + mediaId +
            "&output=jsonp&callback=" + cb + "&tech=hls&deviceType=ipad&connectionType=hd&multibitrate=true";
    document.head.appendChild(s);
  });
}

// Episode dates look like "2026-09-23T12:00:00.000Z" but are Montréal time,
// so only the calendar date is used.
const ymd = (d) => d.toLocaleDateString("en-CA");

function render(episodes) {
  const days = [...Array(7)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 6 + i); return d; });
  const today = ymd(new Date());

  const head = document.getElementById("head");
  head.innerHTML = '<div class="head"></div>' + days.map((d) => `
    <div class="head ${ymd(d) === today ? "today" : ""}">
      <div class="dow">${d.toLocaleDateString("fr-CA", { weekday: "short" })}</div>
      <div class="num">${d.getDate()}</div>
    </div>`).join("");

  const grid = document.getElementById("grid");
  const hours = [...Array(LAST_HOUR - FIRST_HOUR)].map((_, i) => `<div>${i ? FIRST_HOUR + i + " h" : ""}</div>`).join("");
  grid.innerHTML = `<div class="hours">${hours}</div>`;

  const hourPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour"));
  for (const d of days) {
    const col = document.createElement("div");
    col.className = "day";
    for (const ep of episodes.filter((e) => e.date.slice(0, 10) === ymd(d))) {
      const minutes = Math.round(ep.duration.seconds / 60);
      const btn = document.createElement("button");
      btn.className = "event";
      btn.style.top = (ep.show.hour - FIRST_HOUR) * hourPx + "px";
      btn.style.height = Math.max(minutes / 60 * hourPx, 22) + "px";
      btn.style.background = ep.show.color;
      btn.innerHTML = `${ep.show.name} <small>${ep.show.hour} h · ${minutes} min</small>`;
      btn.onclick = () => play(ep);
      col.appendChild(btn);
    }
    grid.appendChild(col);
  }
  document.querySelector(".body").scrollTop = (11 - FIRST_HOUR) * hourPx;
}

let hls;
const dialog = document.getElementById("player");
const video = document.getElementById("video");

async function play(ep) {
  document.getElementById("ptitle").textContent = ep.show.name + " — " + ep.title;
  document.getElementById("plink").href = SITE + ep.url;
  dialog.showModal();
  try {
    const src = await getStreamUrl(await getMediaId(ep.url));
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
    } else {
      hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
    }
  } catch (err) {
    document.getElementById("ptitle").textContent = ep.title + " — " + err.message;
  }
}

function stop() {
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute("src");
  video.load();
}
dialog.addEventListener("close", stop);
document.getElementById("pclose").onclick = () => dialog.close();

// One show failing to load shouldn't hide the others.
Promise.allSettled(SHOWS.map(getEpisodes)).then((results) => {
  render(results.flatMap((r) => r.value || []));
  const failed = SHOWS.filter((_, i) => results[i].status === "rejected").map((s) => s.name);
  document.getElementById("status").textContent = failed.length ? "Erreur : " + failed.join(", ") : "";
});
