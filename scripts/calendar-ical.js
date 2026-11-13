/*
 * Material You NewTab
 * Copyright (c) 2023-2025 XengShi
 * Licensed under the GNU General Public License v3.0 (GPL-3.0)
 * You should have received a copy of the GNU General Public License along with this program.
 * If not, see <https://www.gnu.org/licenses/>.
 */

// -------------------- iCalendar (.ics) feed parsing ----------------------
// ICal.parse(text) reads a feed; ICal.expand(calendar, from, to) lists its event
// instances between two timestamps, including repeating events.

const ICal = (() => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    const SUPPORTED_FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
    const MAX_RULE_PERIODS = 20000;

    // Outlook feeds use Windows time zone names, which Intl does not understand
    const WINDOWS_ZONES = {
        "UTC": "UTC",
        "GMT Standard Time": "Europe/London",
        "W. Europe Standard Time": "Europe/Berlin",
        "Romance Standard Time": "Europe/Paris",
        "Central Europe Standard Time": "Europe/Budapest",
        "Central European Standard Time": "Europe/Warsaw",
        "E. Europe Standard Time": "Europe/Bucharest",
        "FLE Standard Time": "Europe/Kiev",
        "Eastern Standard Time": "America/New_York",
        "Central Standard Time": "America/Chicago",
        "Mountain Standard Time": "America/Denver",
        "Pacific Standard Time": "America/Los_Angeles",
        "India Standard Time": "Asia/Kolkata",
        "Tokyo Standard Time": "Asia/Tokyo",
        "AUS Eastern Standard Time": "Australia/Sydney",
    };

    // ------------------------------ Time zones ------------------------------
    const zoneFormatters = new Map();

    function getZoneFormatter(zone) {
        if (!zoneFormatters.has(zone)) {
            let formatter = null;
            try {
                formatter = new Intl.DateTimeFormat("en-US", {
                    timeZone: zone,
                    hourCycle: "h23",
                    year: "numeric",
                    month: "numeric",
                    day: "numeric",
                    hour: "numeric",
                    minute: "numeric",
                    second: "numeric",
                });
            } catch {
                // Unknown zone name
            }
            zoneFormatters.set(zone, formatter);
        }
        return zoneFormatters.get(zone);
    }

    function resolveZone(tzid) {
        if (!tzid) return null;
        const name = WINDOWS_ZONES[tzid] || tzid.replace(/^\//, "");
        return getZoneFormatter(name) ? name : null;
    }

    function zoneOffset(epoch, zone) {
        const parts = {};
        getZoneFormatter(zone).formatToParts(new Date(epoch)).forEach(({ type, value }) => {
            parts[type] = Number(value);
        });
        const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
        return asUtc - Math.floor(epoch / 1000) * 1000;
    }

    // A "wall" time is a calendar reading stored as if it were UTC, which keeps
    // recurrence arithmetic free of daylight saving jumps.
    function wallToEpoch(wall, zone) {
        if (zone === "UTC") return wall;
        if (!zone) {
            const date = new Date(wall);
            return new Date(
                date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
                date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()
            ).getTime();
        }
        const firstGuess = wall - zoneOffset(wall, zone);
        return wall - zoneOffset(firstGuess, zone);
    }

    // ------------------------------ Line parsing ------------------------------
    const unfoldLines = (text) => text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");

    const unescapeText = (value) => value.replace(/\\([\\;,nN])/g, (_, char) => (char.toLowerCase() === "n" ? "\n" : char));

    function splitOutsideQuotes(text, separator) {
        const parts = [];
        let current = "";
        let inQuotes = false;
        for (const char of text) {
            if (char === '"') inQuotes = !inQuotes;
            if (char === separator && !inQuotes) {
                parts.push(current);
                current = "";
            } else {
                current += char;
            }
        }
        parts.push(current);
        return parts;
    }

    function parseLine(line) {
        let inQuotes = false;
        let colon = -1;
        for (let index = 0; index < line.length && colon < 0; index++) {
            if (line[index] === '"') inQuotes = !inQuotes;
            else if (line[index] === ":" && !inQuotes) colon = index;
        }
        if (colon < 0) return null;

        const [name, ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ";");
        const params = {};
        rawParams.forEach((param) => {
            const equals = param.indexOf("=");
            if (equals > 0) params[param.slice(0, equals).toUpperCase()] = param.slice(equals + 1).replace(/"/g, "");
        });
        return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
    }

    // ------------------------------ Property values ------------------------------
    function parseDateTime(value, params, calendarZone) {
        const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
        if (!match) return null;
        const [, year, month, day, hour = "0", minute = "0", second = "0", utc] = match;
        const isDate = match[4] === undefined;

        let zone = null;
        if (utc) zone = "UTC";
        else if (!isDate && params.TZID) zone = resolveZone(params.TZID) || calendarZone;

        return {
            wall: Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
            isDate,
            zone,
        };
    }

    const dateTimeToEpoch = (dateTime) => wallToEpoch(dateTime.wall, dateTime.zone);

    function parseDateList(property, calendarZone) {
        return property.value.split(",")
            .map((value) => parseDateTime(value, property.params, calendarZone))
            .filter(Boolean);
    }

    function parseDuration(value) {
        const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
        if (!match) return null;
        const [, sign, weeks = 0, days = 0, hours = 0, minutes = 0, seconds = 0] = match;
        const total = (Number(weeks) * 7 * DAY_MS) + (Number(days) * DAY_MS)
            + (Number(hours) * 3600000) + (Number(minutes) * 60000) + (Number(seconds) * 1000);
        return sign === "-" ? -total : total;
    }

    function parseRule(value, startZone, calendarZone) {
        const parts = {};
        value.split(";").forEach((part) => {
            const [key, partValue] = part.split("=");
            if (partValue !== undefined) parts[key.toUpperCase()] = partValue.toUpperCase();
        });
        if (!SUPPORTED_FREQUENCIES.includes(parts.FREQ)) return null;

        const numbers = (text) => (text ? text.split(",").map(Number).filter((number) => !Number.isNaN(number)) : []);
        const until = parts.UNTIL ? parseDateTime(parts.UNTIL, {}, calendarZone) : null;
        if (until && !until.isDate && !until.zone) until.zone = startZone;

        return {
            frequency: parts.FREQ,
            interval: Math.max(1, Number(parts.INTERVAL) || 1),
            count: Number(parts.COUNT) || 0,
            until,
            byDay: (parts.BYDAY ? parts.BYDAY.split(",") : []).map((entry) => ({
                ordinal: Number(entry.slice(0, -2)) || 0,
                weekday: WEEKDAYS.indexOf(entry.slice(-2)),
            })).filter(({ weekday }) => weekday >= 0),
            byMonthDay: numbers(parts.BYMONTHDAY),
            byMonth: numbers(parts.BYMONTH).map((month) => month - 1),
            bySetPos: numbers(parts.BYSETPOS),
            weekStart: parts.WKST ? Math.max(WEEKDAYS.indexOf(parts.WKST), 0) : 1,
        };
    }

    // ------------------------------ Recurrence ------------------------------
    const weekdayOf = (day) => new Date(day).getUTCDay();

    function matchesDayRules(day, rule) {
        const date = new Date(day);
        const dayOfMonth = date.getUTCDate();
        const length = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();

        const monthDayMatches = !rule.byMonthDay.length
            || rule.byMonthDay.includes(dayOfMonth)
            || rule.byMonthDay.includes(dayOfMonth - length - 1);
        const weekdayMatches = !rule.byDay.length || rule.byDay.some(({ ordinal, weekday }) => {
            if (weekday !== date.getUTCDay()) return false;
            if (ordinal > 0) return Math.ceil(dayOfMonth / 7) === ordinal;
            if (ordinal < 0) return Math.ceil((length - dayOfMonth + 1) / 7) === -ordinal;
            return true;
        });
        return monthDayMatches && weekdayMatches;
    }

    function daysInMonth(year, month, rule, startDate) {
        const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        if (!rule.byDay.length && !rule.byMonthDay.length) {
            // A month without this date is skipped, as RFC 5545 requires
            return startDate.getUTCDate() <= length ? [Date.UTC(year, month, startDate.getUTCDate())] : [];
        }
        const days = [];
        for (let dayOfMonth = 1; dayOfMonth <= length; dayOfMonth++) {
            const day = Date.UTC(year, month, dayOfMonth);
            if (matchesDayRules(day, rule)) days.push(day);
        }
        return days;
    }

    function getPeriod(index, startDay, rule) {
        const startDate = new Date(startDay);
        const step = index * rule.interval;

        if (rule.frequency === "DAILY") {
            const day = startDay + step * DAY_MS;
            const monthAllowed = !rule.byMonth.length || rule.byMonth.includes(new Date(day).getUTCMonth());
            return { start: day, days: monthAllowed && matchesDayRules(day, rule) ? [day] : [] };
        }

        if (rule.frequency === "WEEKLY") {
            const weekOffset = (weekdayOf(startDay) - rule.weekStart + 7) % 7;
            const weekBegin = startDay - weekOffset * DAY_MS + step * 7 * DAY_MS;
            const weekdays = rule.byDay.length ? rule.byDay.map(({ weekday }) => weekday) : [weekdayOf(startDay)];
            const days = weekdays
                .map((weekday) => weekBegin + ((weekday - rule.weekStart + 7) % 7) * DAY_MS)
                .filter((day) => !rule.byMonth.length || rule.byMonth.includes(new Date(day).getUTCMonth()));
            return { start: weekBegin, days };
        }

        if (rule.frequency === "MONTHLY") {
            const first = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + step, 1));
            const monthAllowed = !rule.byMonth.length || rule.byMonth.includes(first.getUTCMonth());
            return {
                start: first.getTime(),
                days: monthAllowed ? daysInMonth(first.getUTCFullYear(), first.getUTCMonth(), rule, startDate) : [],
            };
        }

        const year = startDate.getUTCFullYear() + step;
        const months = rule.byMonth.length ? rule.byMonth : [startDate.getUTCMonth()];
        return {
            start: Date.UTC(year, 0, 1),
            days: months.flatMap((month) => daysInMonth(year, month, rule, startDate)),
        };
    }

    function applySetPosition(days, positions) {
        if (!positions.length) return days;
        return positions
            .map((position) => days[position > 0 ? position - 1 : days.length + position])
            .filter((day) => day !== undefined);
    }

    function isAfterUntil(wall, zone, until) {
        if (!until) return false;
        if (until.isDate) return wall > until.wall + DAY_MS - 1;
        return wallToEpoch(wall, zone) > dateTimeToEpoch(until);
    }

    function expandRuleWalls(start, rule, fromWall, toWall) {
        const timeOfDay = ((start.wall % DAY_MS) + DAY_MS) % DAY_MS;
        const startDay = start.wall - timeOfDay;
        const walls = [];

        // Long-running series can skip ahead when no COUNT has to be tallied
        let index = 0;
        if (!rule.count && (rule.frequency === "DAILY" || rule.frequency === "WEEKLY")) {
            const periodMs = rule.interval * (rule.frequency === "DAILY" ? 1 : 7) * DAY_MS;
            index = Math.max(0, Math.floor((fromWall - startDay) / periodMs) - 1);
        }

        let produced = 0;
        for (let periods = 0; periods < MAX_RULE_PERIODS; periods++, index++) {
            const period = getPeriod(index, startDay, rule);
            if (period.start > toWall) break;

            const ordered = [...new Set(period.days)].sort((a, b) => a - b);
            const days = applySetPosition(ordered, rule.bySetPos).filter((day) => day >= startDay);
            for (const day of days) {
                const wall = day + timeOfDay;
                if (wall > toWall || isAfterUntil(wall, start.zone, rule.until)) return walls;
                produced++;
                if (wall >= fromWall) walls.push(wall);
                if (rule.count && produced >= rule.count) return walls;
            }
        }
        return walls;
    }

    // ------------------------------ Calendar ------------------------------
    function isDeclinedBy(attendees, owner) {
        return attendees.some((attendee) => attendee.params.PARTSTAT === "DECLINED"
            && attendee.value.replace(/^mailto:/i, "").toLowerCase() === owner);
    }

    function buildEvent(properties, calendarZone, owner) {
        const first = (name) => properties.find((property) => property.name === name);
        const all = (name) => properties.filter((property) => property.name === name);

        const startProperty = first("DTSTART");
        const start = startProperty && parseDateTime(startProperty.value, startProperty.params, calendarZone);
        if (!start) return null;

        let durationMs = start.isDate ? DAY_MS : 0;
        const endProperty = first("DTEND");
        const end = endProperty && parseDateTime(endProperty.value, endProperty.params, calendarZone);
        if (end) {
            durationMs = start.isDate ? end.wall - start.wall : dateTimeToEpoch(end) - dateTimeToEpoch(start);
        } else if (first("DURATION")) {
            durationMs = parseDuration(first("DURATION").value) ?? durationMs;
        }

        const recurrenceProperty = first("RECURRENCE-ID");
        const recurrenceId = recurrenceProperty && parseDateTime(recurrenceProperty.value, recurrenceProperty.params, calendarZone);
        const url = first("URL")?.value.trim();

        return {
            uid: first("UID")?.value.trim() || `${startProperty.value}:${first("SUMMARY")?.value}`,
            title: first("SUMMARY") ? unescapeText(first("SUMMARY").value) : "",
            location: first("LOCATION") ? unescapeText(first("LOCATION").value).trim() : "",
            description: first("DESCRIPTION") ? unescapeText(first("DESCRIPTION").value).trim() : "",
            url: url && /^https:\/\//i.test(url) ? url : null,
            start,
            durationMs: Math.max(durationMs, 0),
            rule: first("RRULE") ? parseRule(first("RRULE").value, start.zone, calendarZone) : null,
            excluded: new Set(all("EXDATE").flatMap((property) => parseDateList(property, calendarZone)).map(dateTimeToEpoch)),
            added: all("RDATE").flatMap((property) => parseDateList(property, calendarZone)),
            replaces: recurrenceId ? dateTimeToEpoch(recurrenceId) : null,
            isHidden: first("STATUS")?.value.trim().toUpperCase() === "CANCELLED"
                || Boolean(owner && isDeclinedBy(all("ATTENDEE"), owner)),
        };
    }

    function parse(text) {
        let isCalendar = false;
        let name = "";
        let zoneName = null;
        let current = null;
        let nesting = 0;
        const rawEvents = [];

        for (const line of unfoldLines(text)) {
            const property = parseLine(line);
            if (!property) continue;
            const value = property.value.trim().toUpperCase();

            if (property.name === "BEGIN") {
                if (value === "VCALENDAR") isCalendar = true;
                if (current) nesting++;
                else if (value === "VEVENT") current = [];
            } else if (property.name === "END") {
                if (current && nesting) {
                    nesting--;
                } else if (current && value === "VEVENT") {
                    rawEvents.push(current);
                    current = null;
                }
            } else if (current && !nesting) {
                current.push(property);
            } else if (!current && property.name === "X-WR-CALNAME") {
                name = unescapeText(property.value.trim());
            } else if (!current && property.name === "X-WR-TIMEZONE") {
                zoneName = property.value.trim();
            }
        }
        if (!isCalendar) throw new Error("Not an iCalendar feed");

        const calendarZone = resolveZone(zoneName);
        const owner = name.includes("@") ? name.toLowerCase() : null;
        const events = rawEvents.map((properties) => buildEvent(properties, calendarZone, owner)).filter(Boolean);

        // Changed or cancelled instances replace their slot in the repeating series
        const replaced = new Map();
        events.filter((event) => event.replaces !== null).forEach((event) => {
            if (!replaced.has(event.uid)) replaced.set(event.uid, new Set());
            replaced.get(event.uid).add(event.replaces);
        });

        return { name, events, replaced };
    }

    function createInstance(event, wall, zone, isDate) {
        const start = wallToEpoch(wall, isDate ? null : zone);
        const end = isDate ? wallToEpoch(wall + event.durationMs, null) : start + event.durationMs;
        return {
            uid: event.uid,
            title: event.title,
            location: event.location,
            description: event.description,
            url: event.url,
            allDay: isDate,
            start,
            end,
        };
    }

    function expand(calendar, from, to) {
        const instances = [];
        calendar.events.filter((event) => !event.isHidden).forEach((event) => {
            const { start } = event;
            const paddedFrom = from - event.durationMs - 2 * DAY_MS;
            const paddedTo = to + 2 * DAY_MS;

            const walls = event.rule ? expandRuleWalls(start, event.rule, paddedFrom, paddedTo) : [start.wall];
            const occurrences = walls.map((wall) => ({ wall, zone: start.zone, isDate: start.isDate }));
            event.added.forEach((added) => occurrences.push({ wall: added.wall, zone: added.zone, isDate: added.isDate }));

            const replaced = calendar.replaced.get(event.uid);
            const seen = new Set();
            occurrences.forEach(({ wall, zone, isDate }) => {
                const instance = createInstance(event, wall, zone, isDate);
                const isRepeat = event.rule || event.added.length;
                if (seen.has(instance.start)) return;
                seen.add(instance.start);
                if (event.excluded.has(instance.start)) return;
                if (isRepeat && event.replaces === null && replaced?.has(instance.start)) return;
                if (instance.start < to && (instance.end > from || (instance.end === instance.start && instance.start >= from))) {
                    instances.push(instance);
                }
            });
        });
        return instances.sort((a, b) => a.start - b.start);
    }

    return { parse, expand };
})();
