/*
 * Material You NewTab
 * Copyright (c) 2023-2025 XengShi
 * Licensed under the GNU General Public License v3.0 (GPL-3.0)
 * You should have received a copy of the GNU General Public License along with this program.
 * If not, see <https://www.gnu.org/licenses/>.
 */

// -------------------- Calendar Side Panel ----------------------
// Events come from iCal links the user adds, one link per calendar.

(() => {
    const UPCOMING_WINDOW_MINUTES = 15;
    // Feed servers (Google's, for one) answer 429 when polled often, so these stay generous
    const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
    const MIN_SYNC_GAP_MS = 25 * 60 * 1000;
    const RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;

    // The theme colours from the settings menu, in the same order (the --darkColor-* values
    // in style.css). Copied rather than read from CSS, because the theme rewrites --darkColor-blue.
    const CALENDAR_COLORS = [
        { name: "Red", value: "#ec4343" },
        { name: "Yellow", value: "#d1a93d" },
        { name: "Green", value: "#5cba5c" },
        { name: "Cyan", value: "#09b2b4" },
        { name: "Blue", value: "#4382ec" },
        { name: "Pink", value: "#ec5e78" },
        { name: "Purple", value: "#9563b5" },
        { name: "Orange", value: "#ec844d" },
        { name: "Brown", value: "#705347" },
        { name: "Silver", value: "#9e9e9e" },
        { name: "Peach", value: "#9c29ba" },
    ];

    const VIEW_KEY = "calendarView";
    const CACHE_KEY = "calendarCache";
    const FEEDS_KEY = "calendarFeeds";
    // Raise this when saved events gain new fields, so older saved events are re-downloaded
    const CACHE_VERSION = 2;
    // Long notes are cut so the saved events stay well inside localStorage limits
    const MAX_DESCRIPTION_LENGTH = 2000;
    // Stored rather than kept in memory, because every new tab runs this script
    const NEXT_SYNC_KEY = "calendarNextSync";
    const RATE_LIMITS_KEY = "calendarRateLimits";

    const button = document.getElementById("calendarButton");
    const iconDay = document.getElementById("calendarIconDay");
    const upcomingDot = document.getElementById("calendarUpcomingDot");
    const panel = document.getElementById("calendarPanel");
    const syncChip = document.getElementById("calendarSyncChip");
    const syncText = document.getElementById("calendarSyncText");
    const content = document.getElementById("calendarContent");
    const body = document.getElementById("calendarBody");
    const manageButton = document.getElementById("calendarManage");
    const setup = document.getElementById("calendarSetup");
    const feedForm = document.getElementById("calendarFeedForm");
    const feedInput = document.getElementById("calendarFeedInput");
    const feedAdd = document.getElementById("calendarFeedAdd");
    const feedError = document.getElementById("calendarFeedError");
    const feedList = document.getElementById("calendarFeedList");
    const feedDone = document.getElementById("calendarFeedDone");
    const tabs = [...panel.querySelectorAll('[role="tab"]')];

    const intlLocale = currentLanguage === "idn" ? "id" : currentLanguage.replace("_", "-");

    function t(key, values = {}) {
        const text = translations[currentLanguage]?.[key] || translations["en"][key];
        return text.replace(/\{(\w+)\}/g, (_, name) => values[name]);
    }

    function readJson(key) {
        try {
            return JSON.parse(localStorage.getItem(key));
        } catch {
            return null;
        }
    }

    // ------------------------------ Date helpers ------------------------------
    const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
    const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
    // Weeks start on Monday, like the month grid
    const startOfWeek = (date) => addDays(date, -((date.getDay() + 6) % 7));
    const isSameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
    const monthKey = (date) => `${date.getFullYear()}-${date.getMonth() + 1}`;
    const pad = (number) => String(number).padStart(2, "0");
    // Follows the clock setting: "hourformat" is "true" when the 12-hour clock is chosen
    const formatTime = (ms) => {
        const date = new Date(ms);
        if (localStorage.getItem("hourformat") === "true") {
            return new Intl.DateTimeFormat(intlLocale, { hour: "numeric", minute: "2-digit", hour12: true }).format(date);
        }
        return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    const formatPart = (date, options) => new Intl.DateTimeFormat(intlLocale, options).format(date);

    function dayLabel(date) {
        const label = `${formatPart(date, { weekday: "short" })} ${date.getDate()}`;
        const today = new Date();
        if (isSameDay(date, today)) return `${t("calendarToday")} · ${label}`;
        if (isSameDay(date, addDays(today, 1))) return `${t("calendarTomorrow")} · ${label}`;
        return label;
    }

    // ------------------------------ State ------------------------------
    const cache = readJson(CACHE_KEY);
    const savedView = localStorage.getItem(VIEW_KEY);
    const state = {
        feeds: readJson(FEEDS_KEY) ?? [],
        feedEvents: cache?.feedEvents ?? {},
        failedFeeds: new Set(),
        isManaging: false,
        // The event shown in the details view, with where to return to
        detail: null,
        colorMenuFeedId: null,
        status: cache?.syncedAt ? "synced" : "syncing",
        view: ["day", "month"].includes(savedView) ? savedView : "week",
        events: null,
        syncedAt: cache?.syncedAt ?? null,
        // Events for weeks or months outside the saved range, keyed by range start
        rangeEvents: new Map(),
        weekCursor: startOfWeek(startOfDay(new Date())),
        monthCursor: startOfMonth(new Date()),
        selectedDay: startOfDay(new Date()),
    };

    // Parsed feeds stay in memory only; other months are expanded from them on demand
    const parsedCalendars = new Map();
    let activeSync = null;

    function saveFeeds() {
        localStorage.setItem(FEEDS_KEY, JSON.stringify(state.feeds));
    }

    function saveCache() {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                version: CACHE_VERSION,
                syncedAt: state.syncedAt,
                feedEvents: state.feedEvents,
            }));
        } catch (error) {
            console.warn("Could not save calendar cache:", error);
        }
    }

    // The same event can appear in several feeds, so keep one copy of it
    function mergeEvents(eventLists) {
        const events = new Map();
        eventLists.flat().forEach((event) => {
            if (!events.has(event.id)) events.set(event.id, event);
        });
        return [...events.values()].sort((a, b) => a.start - b.start);
    }

    function rebuildEvents() {
        const hasLoaded = state.feeds.some((feed) => state.feedEvents[feed.id]);
        // Hidden calendars keep syncing but stay out of every view
        const lists = state.feeds
            .filter((feed) => !feed.hidden)
            .map((feed) => state.feedEvents[feed.id])
            .filter(Boolean);
        state.events = hasLoaded ? mergeEvents(lists) : null;
        state.rangeEvents.clear();
    }

    // ------------------------------ iCal feeds ------------------------------
    // Plain http is only allowed for this computer, e.g. a calendar server running locally
    const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

    function normalizeFeedUrl(text) {
        try {
            const url = new URL(text.trim().replace(/^webcal:/i, "https:"));
            const isLocal = url.protocol === "http:" && LOCAL_HOSTS.includes(url.hostname);
            return url.protocol === "https:" || isLocal ? url : null;
        } catch {
            return null;
        }
    }

    // Must be called directly from a click or submit, or browsers refuse the prompt
    function requestFeedAccess(url) {
        if (typeof chrome === "undefined" || !chrome.permissions?.request) return Promise.resolve(true);
        return new Promise((resolve) => {
            // Without the port, since browser match patterns cover every port of a host
            chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] }, resolve);
        });
    }

    function createRateLimitError(retryAt) {
        const error = new Error("Calendar feed is rate limited");
        error.retryAt = retryAt;
        return error;
    }

    async function fetchCalendar(url) {
        const { host } = new URL(url);
        const retryAt = readJson(RATE_LIMITS_KEY)?.[host] ?? 0;
        if (retryAt > Date.now()) throw createRateLimitError(retryAt);

        const response = await fetch(url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
        if (response.status === 429) {
            const retryAfterMs = Number(response.headers.get("Retry-After")) * 1000 || RATE_LIMIT_BACKOFF_MS;
            const nextRetry = Date.now() + retryAfterMs;
            localStorage.setItem(RATE_LIMITS_KEY, JSON.stringify({ ...readJson(RATE_LIMITS_KEY), [host]: nextRetry }));
            throw createRateLimitError(nextRetry);
        }
        if (!response.ok) throw new Error(`Calendar feed responded with ${response.status}`);
        return ICal.parse(await response.text());
    }

    function scheduleNextSync() {
        localStorage.setItem(NEXT_SYNC_KEY, String(Date.now() + MIN_SYNC_GAP_MS));
    }

    function getCacheRange() {
        const now = new Date();
        // A week can start in the previous month
        const weekStart = startOfWeek(now);
        const monthStart = startOfMonth(now);
        return {
            from: weekStart < monthStart ? weekStart : monthStart,
            to: new Date(now.getFullYear(), now.getMonth() + 2, 1),
        };
    }

    function expandFeed(feed, calendar, from, to) {
        return ICal.expand(calendar, from.getTime(), to.getTime()).map((instance) => {
            return {
                id: `${instance.uid}:${instance.start}`,
                title: instance.title || t("calendarNoTitle"),
                allDay: instance.allDay,
                start: instance.start,
                end: instance.end,
                location: instance.location || "",
                description: (instance.description || "").slice(0, MAX_DESCRIPTION_LENGTH),
                url: instance.url,
                calendarName: feed.name,
                color: feed.color,
            };
        });
    }

    function storeCalendar(feed, calendar) {
        const { from, to } = getCacheRange();
        parsedCalendars.set(feed.id, calendar);
        state.feedEvents[feed.id] = expandFeed(feed, calendar, from, to);
    }

    function getEventsBetween(from, to) {
        const saved = getCacheRange();
        if (state.events && from >= saved.from && to <= saved.to) return state.events;

        const key = from.getTime();
        if (state.rangeEvents.has(key)) return state.rangeEvents.get(key);
        if (!parsedCalendars.size) return null;

        const lists = state.feeds
            .filter((feed) => parsedCalendars.has(feed.id) && !feed.hidden)
            .map((feed) => expandFeed(feed, parsedCalendars.get(feed.id), from, to));
        state.rangeEvents.set(key, mergeEvents(lists));
        return state.rangeEvents.get(key);
    }

    const getMonthEvents = (cursor) => getEventsBetween(cursor, new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));
    const getWeekEvents = (weekStart) => getEventsBetween(weekStart, addDays(weekStart, 7));

    async function runSync() {
        scheduleNextSync();
        state.status = "syncing";
        renderSyncChip();

        const feeds = [...state.feeds];
        const results = await Promise.allSettled(feeds.map((feed) => fetchCalendar(feed.url)));

        let hasUpdate = false;
        results.forEach((result, index) => {
            const feed = feeds[index];
            if (!state.feeds.includes(feed)) return;
            if (result.status === "fulfilled") {
                storeCalendar(feed, result.value);
                state.failedFeeds.delete(feed.id);
                hasUpdate = true;
            } else {
                // A failing feed keeps showing the events saved for it
                console.warn("Calendar feed failed:", result.reason.message);
                state.failedFeeds.add(feed.id);
            }
        });

        if (hasUpdate) state.syncedAt = Date.now();
        state.status = state.failedFeeds.size ? "offline" : "synced";
        rebuildEvents();
        saveCache();
        renderAll();
    }

    function sync({ force = false } = {}) {
        const isWaiting = Date.now() < Number(localStorage.getItem(NEXT_SYNC_KEY));
        if (!state.feeds.length || (!force && isWaiting)) return Promise.resolve();
        activeSync ??= runSync().finally(() => {
            activeSync = null;
        });
        return activeSync;
    }

    // Parsed feeds only live in memory, so a range outside the saved one may need a fetch
    function ensureVisibleEvents() {
        const events = state.view === "month" ? getMonthEvents(state.monthCursor)
            : state.view === "week" ? getWeekEvents(state.weekCursor)
                : state.events;
        if (state.feeds.length && !events) sync({ force: true });
    }

    // ------------------------------ Event lists ------------------------------
    function eventsOnDay(events, dayStart) {
        const from = dayStart.getTime();
        const to = addDays(dayStart, 1).getTime();
        return events
            .filter((event) => event.start < to && event.end > from)
            .map((event) => ({
                event,
                allDay: event.allDay || (event.start <= from && event.end >= to),
            }))
            .sort((a, b) => (b.allDay - a.allDay) || (a.event.start - b.event.start));
    }

    function getNextEvent(now) {
        return state.events?.find((event) => !event.allDay && event.start > now) ?? null;
    }

    function formatCountdown(ms) {
        const minutes = Math.ceil(ms / 60000);
        if (minutes < 60) return t("calendarInMinutes", { n: minutes });
        if (minutes < 24 * 60) return t("calendarInHours", { n: Math.round(minutes / 60) });
        return t("calendarInDays", { n: Math.round(minutes / (24 * 60)) });
    }

    function createElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function createEventRow({ event, allDay }, dayStart, now, nextEvent) {
        const from = dayStart.getTime();
        const to = addDays(dayStart, 1).getTime();
        const isNext = nextEvent?.id === event.id && event.start >= from && event.start < to;
        const isPast = allDay ? to <= now : event.end <= now;

        let time = t("calendarAllDay");
        if (!allDay) {
            const startText = formatTime(Math.max(event.start, from));
            const endText = formatTime(Math.min(event.end, to));
            time = startText === endText ? startText : `${startText} – ${endText}`;
        }
        if (isNext) time += ` · ${formatCountdown(event.start - now)}`;

        const row = createElement("button", "calendar-event");
        row.type = "button";
        row.dataset.calKey = `event-${event.id}-${from}`;
        row.addEventListener("click", () => openDetails(event, row.dataset.calKey));
        row.classList.toggle("is-next", isNext);
        row.classList.toggle("is-past", isPast);

        const bar = createElement("span", "calendar-event-bar");
        bar.style.background = event.color;
        const text = createElement("span", "calendar-event-text");
        text.append(
            createElement("span", "calendar-event-title", event.title),
            createElement("span", "calendar-event-time", time)
        );
        row.append(bar, text);
        return row;
    }

    // ------------------------------ Event details ------------------------------
    const ICONS = {
        pin: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
        clock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
        notes: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h9"/></svg>',
    };

    // Some feeds (Google's included) send notes as HTML; DOMParser reads it as text without running anything
    function toPlainText(text) {
        if (!/<[a-z][\s\S]*>/i.test(text)) return text;
        const html = text.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n");
        const doc = new DOMParser().parseFromString(html, "text/html");
        doc.querySelectorAll("script, style").forEach((element) => element.remove());
        return doc.body.textContent.trim();
    }

    function formatWhen(event) {
        const dateText = (ms) => formatPart(new Date(ms), { weekday: "short", day: "numeric", month: "short" });
        if (event.allDay) {
            const lastDay = addDays(new Date(event.end), -1).getTime();
            return lastDay > event.start
                ? `${dateText(event.start)} – ${dateText(lastDay)}`
                : `${dateText(event.start)} · ${t("calendarAllDay")}`;
        }
        if (event.end <= event.start) return `${dateText(event.start)} · ${formatTime(event.start)}`;
        if (isSameDay(new Date(event.start), new Date(event.end - 1))) {
            return `${dateText(event.start)} · ${formatTime(event.start)} – ${formatTime(event.end)}`;
        }
        return `${dateText(event.start)} ${formatTime(event.start)} – ${dateText(event.end)} ${formatTime(event.end)}`;
    }

    function createDetailLine(icon, content, className = "") {
        const line = createElement("div", `calendar-details-line ${className}`.trim());
        if (icon) line.innerHTML = ICONS[icon];
        line.append(content);
        return line;
    }

    function createLink(className, href, text) {
        const link = createElement("a", className, text);
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        return link;
    }

    function renderDetails(event) {
        const details = createElement("div", "calendar-details");
        details.append(createNavButton("details-back", t("calendarBack"), "M15 18l-6-6 6-6", closeDetails));
        details.append(createElement("h3", "calendar-details-title", event.title));

        if (event.calendarName) {
            const dot = createElement("span", "calendar-details-dot");
            dot.style.background = event.color;
            const line = createDetailLine(null, event.calendarName);
            line.prepend(dot);
            details.append(line);
        }
        details.append(createDetailLine("clock", formatWhen(event)));

        if (event.location) {
            // Online meetings put their link here; anything else opens in Google Maps
            const href = /^https:\/\//i.test(event.location)
                ? event.location
                : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`;
            details.append(createDetailLine("pin", createLink("calendar-details-link", href, event.location)));
        }
        if (event.description) {
            details.append(createDetailLine("notes", toPlainText(event.description), "calendar-details-notes"));
        }

        if (event.url) {
            const actions = createElement("div", "calendar-details-actions");
            actions.append(createLink("calendar-open", event.url, t("calendarEventPage")));
            details.append(actions);
        }
        return [details];
    }

    function openDetails(event, returnKey) {
        state.detail = { event, returnKey, scrollTop: body.scrollTop };
        renderBody();
        body.scrollTop = 0;
        body.querySelector('[data-cal-key="details-back"]').focus();
    }

    function closeDetails() {
        const { returnKey, scrollTop } = state.detail;
        state.detail = null;
        renderBody();
        body.scrollTop = scrollTop;
        body.querySelector(`[data-cal-key="${CSS.escape(returnKey)}"]`)?.focus();
    }

    function createMessage(text) {
        return createElement("p", "calendar-message", text);
    }

    function createEmptyState() {
        return createMessage(t("calendarNothingScheduled"));
    }

    function createDayGroup(items, label, dayStart, now, nextEvent) {
        const group = createElement("div", "calendar-group");
        group.append(createElement("span", "calendar-group-label", label));
        items.forEach((item) => group.append(createEventRow(item, dayStart, now, nextEvent)));
        return group;
    }

    // ------------------------------ Views ------------------------------
    function renderWeek(now, nextEvent) {
        const today = new Date(now);
        const weekStart = state.weekCursor;
        const weekEnd = addDays(weekStart, 6);
        const events = getWeekEvents(weekStart);

        const rangeOptions = { day: "numeric", month: "short" };
        if (weekStart.getFullYear() !== today.getFullYear() || weekEnd.getFullYear() !== today.getFullYear()) {
            rangeOptions.year = "numeric";
        }
        const header = createElement("div", "calendar-month-header");
        const nav = createElement("div", "calendar-month-navs");
        const moveWeek = (delta) => () => {
            state.weekCursor = addDays(state.weekCursor, delta * 7);
            renderBody();
            scrollToToday();
            ensureVisibleEvents();
        };
        nav.append(
            createNavButton("week-prev", t("calendarPrevWeek"), "M15 18l-6-6 6-6", moveWeek(-1)),
            createNavButton("week-next", t("calendarNextWeek"), "M9 18l6-6-6-6", moveWeek(1))
        );
        header.append(
            createElement("span", "calendar-month-title",
                new Intl.DateTimeFormat(intlLocale, rangeOptions).formatRange(weekStart, weekEnd)),
            nav
        );

        if (!events) {
            return state.status === "offline" ? [header, createMessage(t("calendarLoadFailed"))] : [header];
        }

        const groups = [];
        for (let offset = 0; offset < 7; offset++) {
            const day = addDays(weekStart, offset);
            const items = eventsOnDay(events, day);
            const group = createDayGroup(items, dayLabel(day), day, now, nextEvent);
            if (!items.length) group.append(createMessage(t("calendarNothingScheduled")));
            group.classList.toggle("is-today-group", isSameDay(day, today));
            groups.push(group);
        }
        return [header, ...groups];
    }

    // Past days of the week sit above today, so start the list at today
    function scrollToToday() {
        const todayGroup = body.querySelector(".is-today-group");
        body.scrollTop = todayGroup ? todayGroup.offsetTop - body.offsetTop : 0;
    }

    function renderDay(now, nextEvent) {
        const today = startOfDay(new Date(now));
        const items = eventsOnDay(state.events, today);
        if (!items.length) return [createEmptyState()];

        const nodes = [createDayGroup(items, dayLabel(today), today, now, nextEvent)];
        if (!items.some(({ event, allDay }) => !allDay && event.end > now)) {
            nodes.push(createMessage(t("calendarNothingElseToday")));
        }
        return nodes;
    }

    function createNavButton(key, label, path, onClick) {
        const navButton = createElement("button", "calendar-month-nav");
        navButton.type = "button";
        navButton.dataset.calKey = key;
        navButton.setAttribute("aria-label", label);
        navButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
        navButton.addEventListener("click", onClick);
        return navButton;
    }

    function createDayCell(date, events, today) {
        const cell = createElement("button", "calendar-day");
        const items = eventsOnDay(events, date);
        const isToday = isSameDay(date, today);
        const isSelected = isSameDay(date, state.selectedDay);
        const name = `${formatPart(date, { weekday: "short" })} ${date.getDate()} ${formatPart(date, { month: "long" })}`;

        cell.type = "button";
        cell.dataset.calKey = `day-${date.getTime()}`;
        cell.setAttribute("aria-label", items.length ? `${name}, ${t("calendarHasEvents")}` : name);
        cell.setAttribute("aria-pressed", String(isSelected));
        cell.classList.toggle("is-today", isToday);
        cell.classList.toggle("is-selected", isSelected);

        const dot = createElement("span", "calendar-day-dot");
        if (items.length && !isToday) dot.style.background = items[0].event.color;
        cell.classList.toggle("has-events", items.length > 0);
        cell.append(createElement("span", "", String(date.getDate())), dot);

        cell.addEventListener("click", () => {
            state.selectedDay = date;
            renderBody();
        });
        return cell;
    }

    function renderMonth(now, nextEvent) {
        const cursor = state.monthCursor;
        const today = new Date(now);
        const loadedEvents = getMonthEvents(cursor);
        const events = loadedEvents ?? [];

        const header = createElement("div", "calendar-month-header");
        const title = createElement("span", "calendar-month-title", formatPart(cursor, { month: "long" }));
        title.append(" ", createElement("span", "calendar-month-year", String(cursor.getFullYear())));
        const nav = createElement("div", "calendar-month-navs");
        const moveMonth = (delta) => () => {
            state.monthCursor = new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
            renderBody();
            ensureVisibleEvents();
        };
        nav.append(
            createNavButton("prev", t("calendarPrevMonth"), "M15 18l-6-6 6-6", moveMonth(-1)),
            createNavButton("next", t("calendarNextMonth"), "M9 18l6-6-6-6", moveMonth(1))
        );
        header.append(title, nav);

        const weekdays = createElement("div", "calendar-weekdays");
        // 1 January 2024 was a Monday
        for (let offset = 0; offset < 7; offset++) {
            weekdays.append(createElement("span", "", formatPart(new Date(2024, 0, 1 + offset), { weekday: "narrow" })));
        }

        const grid = createElement("div", "calendar-month-grid");
        const firstCell = addDays(cursor, -((cursor.getDay() + 6) % 7));
        for (let offset = 0; offset < 42; offset++) {
            const date = addDays(firstCell, offset);
            if (date.getMonth() === cursor.getMonth()) {
                grid.append(createDayCell(date, events, today));
            } else {
                const filler = createElement("span", "calendar-day is-outside", String(date.getDate()));
                filler.setAttribute("aria-hidden", "true");
                grid.append(filler);
            }
        }

        const selected = state.selectedDay;
        const nodes = [header, weekdays, grid, createElement("div", "calendar-divider")];
        if (monthKey(selected) !== monthKey(cursor)) return nodes;

        const label = `${dayLabel(selected)} ${formatPart(selected, { month: "short" })}`;
        const items = eventsOnDay(events, selected);
        if (items.length) {
            nodes.push(createDayGroup(items, label, selected, now, nextEvent));
        } else {
            nodes.push(createElement("span", "calendar-group-label", label));
            if (loadedEvents) {
                nodes.push(createEmptyState());
            } else if (state.status === "offline") {
                nodes.push(createMessage(t("calendarLoadFailed")));
            }
        }
        return nodes;
    }

    // ------------------------------ Rendering ------------------------------
    function renderBody() {
        const scrollTop = body.scrollTop;
        const focusKey = body.contains(document.activeElement) ? document.activeElement.dataset.calKey : null;
        const now = Date.now();
        const nextEvent = getNextEvent(now);

        let nodes = [];
        if (state.detail) {
            nodes = renderDetails(state.detail.event);
        } else if (state.view === "month") {
            nodes = renderMonth(now, nextEvent);
        } else if (state.view === "week") {
            nodes = renderWeek(now, nextEvent);
        } else if (state.events) {
            nodes = renderDay(now, nextEvent);
        } else if (state.status === "offline") {
            nodes = [createMessage(t("calendarLoadFailed"))];
        }
        body.replaceChildren(...nodes);
        body.scrollTop = scrollTop;

        if (focusKey) {
            body.querySelector(`[data-cal-key="${CSS.escape(focusKey)}"]`)?.focus();
        }
    }

    function renderSyncChip() {
        syncChip.dataset.status = state.status;
        if (state.status === "syncing") {
            syncText.textContent = t("calendarSyncing");
        } else if (state.status === "offline") {
            syncText.textContent = t("calendarOffline");
        } else if (state.syncedAt) {
            const minutes = Math.floor((Date.now() - state.syncedAt) / 60000);
            if (minutes < 1) {
                syncText.textContent = t("calendarSyncedNow");
            } else if (minutes < 60) {
                syncText.textContent = t("calendarSyncedMinutes", { n: minutes });
            } else {
                syncText.textContent = t("calendarSyncedHours", { n: Math.floor(minutes / 60) });
            }
        }
    }

    function renderTabs() {
        tabs.forEach((tab) => {
            const isSelected = tab.dataset.view === state.view;
            tab.setAttribute("aria-selected", String(isSelected));
            tab.tabIndex = isSelected ? 0 : -1;
            if (isSelected) body.setAttribute("aria-labelledby", tab.id);
        });
    }

    function setFeedColor(feed, color) {
        feed.color = color;
        saveFeeds();
        state.feedEvents[feed.id]?.forEach((event) => {
            event.color = color;
        });
        rebuildEvents();
        saveCache();
    }

    function createColorMenu(feed) {
        const menu = createElement("div", "calendar-color-menu");
        menu.setAttribute("role", "group");
        menu.setAttribute("aria-label", `${t("calendarFeedColor")}: ${feed.name}`);
        CALENDAR_COLORS.forEach(({ name, value }) => {
            const option = createElement("button", "calendar-color-option");
            option.type = "button";
            option.title = name;
            option.style.background = value;
            option.setAttribute("aria-label", name);
            option.setAttribute("aria-pressed", String(feed.color.toLowerCase() === value));
            option.addEventListener("click", () => {
                setFeedColor(feed, value);
                state.colorMenuFeedId = null;
                renderFeedList();
                feedList.querySelector(`[data-feed-id="${feed.id}"]`).focus();
            });
            menu.append(option);
        });
        return menu;
    }

    function renameFeed(feed, name) {
        const newName = name.trim();
        if (newName && newName !== feed.name) {
            feed.name = newName;
            saveFeeds();
            state.feedEvents[feed.id]?.forEach((event) => {
                event.calendarName = newName;
            });
            rebuildEvents();
            saveCache();
        }
        // Also puts back the old name when the field was left empty
        renderFeedList();
    }

    function renderFeedList() {
        // A refresh finishing mid-rename would otherwise wipe what is being typed
        if (document.activeElement?.classList.contains("calendar-feed-name")) return;

        feedList.replaceChildren(...state.feeds.map((feed) => {
            const item = createElement("li", "calendar-feed");
            item.classList.toggle("is-hidden", Boolean(feed.hidden));
            const isMenuOpen = state.colorMenuFeedId === feed.id;
            const colorButton = createElement("button", "calendar-feed-color");
            colorButton.type = "button";
            colorButton.style.background = feed.color;
            colorButton.dataset.feedId = feed.id;
            colorButton.setAttribute("aria-label", `${t("calendarFeedColor")}: ${feed.name}`);
            colorButton.setAttribute("aria-expanded", String(isMenuOpen));
            colorButton.addEventListener("click", () => {
                state.colorMenuFeedId = isMenuOpen ? null : feed.id;
                renderFeedList();
                feedList.querySelector(`[data-feed-id="${feed.id}"]`).focus();
            });

            const nameInput = createElement("input", "calendar-feed-name");
            nameInput.type = "text";
            nameInput.value = feed.name;
            nameInput.maxLength = 60;
            nameInput.autocomplete = "off";
            nameInput.spellcheck = false;
            nameInput.setAttribute("aria-label", `${t("calendarFeedRename")}: ${feed.name}`);
            nameInput.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    nameInput.blur();
                } else if (event.key === "Escape") {
                    // Cancel the rename without also closing the panel
                    event.stopPropagation();
                    nameInput.value = feed.name;
                    nameInput.blur();
                }
            });
            nameInput.addEventListener("change", () => renameFeed(feed, nameInput.value));

            const text = createElement("span", "calendar-event-text");
            text.append(nameInput);
            if (state.failedFeeds.has(feed.id)) {
                text.append(createElement("span", "calendar-event-time", t("calendarFeedBroken")));
            }

            const visibility = createElement("button", "calendar-feed-edit");
            visibility.type = "button";
            visibility.dataset.visibilityId = feed.id;
            visibility.setAttribute("aria-label", `${t(feed.hidden ? "calendarFeedShow" : "calendarFeedHide")}: ${feed.name}`);
            visibility.innerHTML = feed.hidden ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
            visibility.addEventListener("click", () => {
                feed.hidden = !feed.hidden;
                saveFeeds();
                rebuildEvents();
                renderFeedList();
                feedList.querySelector(`[data-visibility-id="${feed.id}"]`).focus();
            });

            const edit = createElement("button", "calendar-feed-edit");
            edit.type = "button";
            edit.setAttribute("aria-label", `${t("calendarFeedRename")}: ${feed.name}`);
            edit.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';
            edit.addEventListener("click", () => {
                nameInput.focus();
                nameInput.select();
            });

            const remove = createElement("button", "calendar-feed-remove", "×");
            remove.type = "button";
            remove.setAttribute("aria-label", `${t("calendarFeedRemove")}: ${feed.name}`);
            remove.dataset.removeId = feed.id;
            remove.addEventListener("click", async () => {
                const isConfirmed = await confirmPrompt(
                    t("calendarFeedRemoveConfirm", { name: feed.name }),
                    t("calendarFeedRemoveOk"),
                    translations[currentLanguage]?.cancelText || translations["en"].cancelText
                );
                if (isConfirmed) {
                    removeFeed(feed);
                } else {
                    feedList.querySelector(`[data-remove-id="${feed.id}"]`)?.focus();
                }
            });

            item.append(colorButton, text, visibility, edit, remove);
            if (isMenuOpen) item.append(createColorMenu(feed));
            return item;
        }));
        feedDone.hidden = !state.feeds.length;
    }

    const isSetupVisible = () => !state.feeds.length || state.isManaging;

    function renderAll() {
        const showSetup = isSetupVisible();
        panel.classList.toggle("is-setup", showSetup);
        content.hidden = showSetup;
        setup.hidden = !showSetup;
        syncChip.hidden = showSetup;
        manageButton.hidden = showSetup;

        updateButton();
        if (showSetup) {
            renderFeedList();
        } else {
            renderSyncChip();
            renderTabs();
            renderBody();
        }
    }

    function updateButton() {
        const now = Date.now();
        const nextEvent = getNextEvent(now);
        iconDay.textContent = String(new Date(now).getDate());
        upcomingDot.hidden = !nextEvent
            || nextEvent.start - now > UPCOMING_WINDOW_MINUTES * 60000;
    }

    // ------------------------------ Panel behaviour ------------------------------
    const isOpen = () => !panel.hidden;
    // The extension's shared confirm dialog lives outside the panel (see alert-modal.js)
    const isDialogOpen = () => document.getElementById("prompt-modal-container")?.style.display === "flex";

    function openPanel() {
        panel.hidden = false;
        button.setAttribute("aria-expanded", "true");
        button.setAttribute("aria-label", t("calendarClose"));
        button.classList.add("menu-open");
        // Each opening starts again from today
        const today = startOfDay(new Date());
        state.weekCursor = startOfWeek(today);
        state.monthCursor = startOfMonth(today);
        state.selectedDay = today;
        renderAll();
        scrollToToday();
        panel.focus();
        sync();
    }

    function closePanel(restoreFocus) {
        panel.hidden = true;
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("aria-label", t("calendarOpen"));
        button.classList.remove("menu-open");
        state.isManaging = false;
        state.detail = null;
        state.colorMenuFeedId = null;
        feedInput.value = "";
        showFeedError(null);
        if (restoreFocus) button.focus();
    }

    function selectView(view, focusTab = false) {
        state.detail = null;
        state.view = view;
        localStorage.setItem(VIEW_KEY, view);
        renderTabs();
        renderBody();
        scrollToToday();
        if (focusTab) tabs.find((tab) => tab.dataset.view === view).focus();
        ensureVisibleEvents();
    }

    button.addEventListener("click", () => {
        if (isOpen()) {
            closePanel(true);
        } else {
            openPanel();
        }
    });

    // Runs in the capture phase so widgets that stop propagation still close the panel.
    // composedPath is used because clicked elements may be replaced when the body re-renders.
    document.addEventListener("click", (event) => {
        if (!isOpen() || isDialogOpen()) return;
        const path = event.composedPath();
        if (path.includes(panel) || path.includes(button)) return;
        closePanel(document.activeElement === document.body || panel.contains(document.activeElement));
    }, true);

    document.addEventListener("keydown", (event) => {
        // While a dialog is open, Escape belongs to the dialog
        if (event.key !== "Escape" || !isOpen() || isDialogOpen()) return;
        // Escape steps back out of an event's details before it closes the panel
        if (state.detail) {
            closeDetails();
        } else {
            closePanel(true);
        }
    });

    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => selectView(tab.dataset.view));
        tab.addEventListener("keydown", (event) => {
            const targets = {
                ArrowRight: (index + 1) % tabs.length,
                ArrowLeft: (index - 1 + tabs.length) % tabs.length,
                Home: 0,
                End: tabs.length - 1,
            };
            if (event.key in targets) {
                event.preventDefault();
                selectView(tabs[targets[event.key]].dataset.view, true);
            }
        });
    });

    function showFeedError(key, reason, values) {
        feedError.hidden = !key;
        feedError.textContent = key ? `${t(key, values)}${reason ? ` (${reason})` : ""}` : "";
    }

    function removeFeed(feed) {
        state.feeds = state.feeds.filter((other) => other !== feed);
        delete state.feedEvents[feed.id];
        parsedCalendars.delete(feed.id);
        state.failedFeeds.delete(feed.id);
        saveFeeds();

        rebuildEvents();
        if (state.feeds.length) {
            state.status = state.failedFeeds.size ? "offline" : "synced";
            saveCache();
        } else {
            state.syncedAt = null;
            localStorage.removeItem(CACHE_KEY);
        }
        renderAll();
        feedInput.focus();
    }

    feedForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        showFeedError(null);

        const url = normalizeFeedUrl(feedInput.value);
        if (!url) {
            showFeedError("calendarFeedInvalid");
            return;
        }
        if (state.feeds.some((feed) => feed.url === url.href)) {
            showFeedError("calendarFeedDuplicate");
            return;
        }
        if (!await requestFeedAccess(url)) {
            showFeedError("calendarFeedDenied");
            return;
        }

        feedAdd.disabled = true;
        try {
            const calendar = await fetchCalendar(url.href);
            const feed = {
                id: crypto.randomUUID(),
                url: url.href,
                name: calendar.name || url.hostname,
                color: CALENDAR_COLORS[state.feeds.length % CALENDAR_COLORS.length].value,
            };
            // Store the events first, so a link is only saved once it has fully worked
            storeCalendar(feed, calendar);
            state.feeds.push(feed);
            saveFeeds();
            rebuildEvents();
            state.syncedAt = Date.now();
            scheduleNextSync();
            state.status = state.failedFeeds.size ? "offline" : "synced";
            saveCache();
            feedInput.value = "";
            state.isManaging = true;
            renderAll();
            feedInput.focus();
        } catch (error) {
            console.warn("Could not add calendar feed:", error.message);
            if (error.retryAt) {
                showFeedError("calendarFeedRateLimited", null, { n: Math.ceil((error.retryAt - Date.now()) / 60000) });
            } else {
                showFeedError("calendarFeedFailed", error.message);
            }
        } finally {
            feedAdd.disabled = false;
        }
    });

    manageButton.addEventListener("click", () => {
        state.isManaging = true;
        renderAll();
        feedInput.focus();
    });

    feedDone.addEventListener("click", () => {
        state.isManaging = false;
        feedInput.value = "";
        showFeedError(null);
        renderAll();
        scrollToToday();
        panel.focus();
    });

    // ------------------------------ Timers ------------------------------
    function onMinuteChange() {
        updateButton();
        if (isOpen() && !isSetupVisible()) {
            renderSyncChip();
            renderBody();
        }
    }

    function scheduleMinuteTick() {
        setTimeout(() => {
            onMinuteChange();
            scheduleMinuteTick();
        }, 60000 - (Date.now() % 60000));
    }

    setInterval(() => {
        if (!document.hidden) sync();
    }, REFRESH_INTERVAL_MS);

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) return;
        onMinuteChange();
        sync();
    });

    // ------------------------------ Start ------------------------------
    manageButton.setAttribute("aria-label", t("calendarManage"));
    feedInput.placeholder = t("calendarFeedPlaceholder");
    feedInput.setAttribute("aria-label", t("calendarFeedPlaceholder"));
    rebuildEvents();
    renderAll();
    // Saved events in an older cache format are missing fields, so fetch fresh ones straight away
    sync({ force: Boolean(cache) && cache.version !== CACHE_VERSION });
    scheduleMinuteTick();
})();
