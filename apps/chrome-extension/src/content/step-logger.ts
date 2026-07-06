import { RECORDING_STATE_KEY } from "../shared/storage-keys";
import type { StepEvent, StepEventKind, StepEventRequest } from "../shared/types";

// A second, independent content script (same manifest content_scripts array
// as bootstrap.ts, same isolated world, no shared state with it) that logs
// page interactions with a real, precise tVideo computed directly from the
// active recording's own startedAt — read straight out of the same
// chrome.storage.session RECORDING_STATE_KEY bootstrap.ts already watches.
// Unlike a Chrome DevTools Recorder export correlated after the fact against
// a HAR/trace, this never needs reconstruction: the timestamp is exact at
// capture time because it is computed from the same clock the recording
// itself is keyed on. Kept dependency-free like bootstrap.ts so it stays
// cheap on every page load; never logs typed values (change/input events
// carry only a selector/label, never the value the user typed).

type ActiveRecording = {
	videoId: string;
	startedAt: number;
};

const readActiveRecording = (value: unknown): ActiveRecording | null => {
	if (!value || typeof value !== "object") return null;
	const status = (value as { status?: unknown }).status;
	if (!status || typeof status !== "object") return null;
	const candidate = status as {
		phase?: unknown;
		videoId?: unknown;
		startedAt?: unknown;
	};
	if (candidate.phase !== "recording") return null;
	if (
		typeof candidate.videoId !== "string" ||
		typeof candidate.startedAt !== "number"
	) {
		return null;
	}
	return { videoId: candidate.videoId, startedAt: candidate.startedAt };
};

// Looks stable across reloads/deploys, unlike CSS-module or utility-class
// hashes (e.g. "css-1x2y3z", "a8f3c1") which regenerate per build.
const looksStable = (value: string) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value) && !/^[a-f0-9]{6,}$/i.test(value);

const cssEscape = (value: string) =>
	typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");

const nthOfTypeSelector = (el: Element): string => {
	const parent = el.parentElement;
	const tag = el.tagName.toLowerCase();
	if (!parent) return tag;
	const siblings = Array.from(parent.children).filter(
		(sibling) => sibling.tagName === el.tagName,
	);
	if (siblings.length <= 1) return tag;
	const index = siblings.indexOf(el) + 1;
	return `${tag}:nth-of-type(${index})`;
};

const pickSelector = (el: Element): string | null => {
	const id = el.getAttribute("id");
	if (id && looksStable(id)) return `#${cssEscape(id)}`;

	const testId = el.getAttribute("data-testid") ?? el.getAttribute("data-test-id");
	if (testId) return `[data-testid="${cssEscape(testId)}"]`;

	const ariaLabel = el.getAttribute("aria-label");
	if (ariaLabel) return `[aria-label="${cssEscape(ariaLabel)}"]`;

	const stableClasses = Array.from(el.classList).filter(looksStable).slice(0, 2);
	if (stableClasses.length > 0) {
		return `${el.tagName.toLowerCase()}.${stableClasses.map(cssEscape).join(".")}`;
	}

	// Walk up to 3 ancestors for a bit more disambiguation than a bare
	// tag:nth-of-type, without building a full, brittle root-to-leaf path.
	const parts: string[] = [];
	let node: Element | null = el;
	for (let depth = 0; node && depth < 3; depth += 1) {
		parts.unshift(nthOfTypeSelector(node));
		node = node.parentElement;
	}
	return parts.length > 0 ? parts.join(" > ") : null;
};

const truncate = (value: string, max: number) =>
	value.length > max ? `${value.slice(0, max - 1)}…` : value;

const textLabel = (el: Element): string | null => {
	const ariaLabel = el.getAttribute("aria-label");
	if (ariaLabel?.trim()) return truncate(ariaLabel.trim(), 80);

	const placeholder = el.getAttribute("placeholder");
	if (placeholder?.trim()) return truncate(placeholder.trim(), 80);

	const text = el.textContent?.trim();
	if (text) return truncate(text.replace(/\s+/g, " "), 80);

	return null;
};

const labelFor = (el: Element, kind: StepEventKind, selector: string | null): string => {
	const text = textLabel(el);
	const verb: Record<StepEventKind, string> = {
		click: "Click",
		doubleClick: "Double-click",
		change: "Change",
		keyDown: "Press key in",
	};
	if (text) return `${verb[kind]} ${text}`;
	if (selector) return `${verb[kind]} ${selector}`;
	return `${verb[kind]} ${el.tagName.toLowerCase()}`;
};

const main = () => {
	let active: ActiveRecording | null = null;
	let stepIndex = 0;
	let listenersAttached = false;

	const send = (kind: StepEventKind, el: Element) => {
		if (!active) return;
		const selector = pickSelector(el);
		const ariaLabel = el.getAttribute("aria-label");
		const title = el.getAttribute("title");
		const step: StepEvent = {
			index: stepIndex,
			kind,
			selector,
			label: labelFor(el, kind, selector),
			ariaLabel: ariaLabel?.trim() ? truncate(ariaLabel.trim(), 80) : null,
			title: title?.trim() ? truncate(title.trim(), 80) : null,
			url: window.location.href,
			tVideo: (Date.now() - active.startedAt) / 1000,
			tWall: new Date().toISOString(),
		};
		stepIndex += 1;

		const message: StepEventRequest = {
			target: "service-worker",
			type: "step-event",
			videoId: active.videoId as StepEventRequest["videoId"],
			step,
		};
		try {
			chrome.runtime.sendMessage(message, () => {
				void chrome.runtime.lastError;
			});
		} catch {
			// Extension context invalidated (e.g. reloaded mid-recording) — the
			// step is simply lost, same failure mode as a dropped network
			// request; not worth buffering across a context that no longer
			// exists.
		}
	};

	const onClick = (event: MouseEvent) => {
		if (!event.isTrusted || !(event.target instanceof Element)) return;
		send(event.detail >= 2 ? "doubleClick" : "click", event.target);
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (!event.isTrusted || !(event.target instanceof Element)) return;
		send("keyDown", event.target);
	};

	const onChange = (event: Event) => {
		if (!event.isTrusted || !(event.target instanceof Element)) return;
		// Deliberately never reads (event.target as HTMLInputElement).value —
		// same redaction stance as chrome_recorder.py's sanitized_copy: a typed
		// value can be a real password/API key, a selector/label never is.
		send("change", event.target);
	};

	const attachListeners = () => {
		if (listenersAttached) return;
		listenersAttached = true;
		document.addEventListener("click", onClick, true);
		document.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("change", onChange, true);
	};

	const detachListeners = () => {
		if (!listenersAttached) return;
		listenersAttached = false;
		document.removeEventListener("click", onClick, true);
		document.removeEventListener("keydown", onKeyDown, true);
		document.removeEventListener("change", onChange, true);
	};

	const applyState = (value: unknown) => {
		const next = readActiveRecording(value);
		// A fresh videoId (new recording) should restart the step index rather
		// than continuing whatever count a previous recording in this same tab
		// left off at.
		if (next && (!active || active.videoId !== next.videoId)) {
			stepIndex = 0;
		}
		active = next;
		if (next) attachListeners();
		else detachListeners();
	};

	try {
		chrome.storage.session.get([RECORDING_STATE_KEY], (items) => {
			if (chrome.runtime.lastError || !items) return;
			applyState(items[RECORDING_STATE_KEY]);
		});
	} catch {
		// Session storage access is widened by the service worker on startup;
		// until that has happened there is no recording state to read either.
	}

	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== "session") return;
		if (RECORDING_STATE_KEY in changes) {
			applyState(changes[RECORDING_STATE_KEY]?.newValue);
		}
	});
};

// Mirrors bootstrap.ts's re-injection guard: chrome.scripting.executeScript
// can re-run this file in the same isolated world.
const STEP_LOGGER_FLAG = "__capExtensionStepLogger";
const globalScope = globalThis as Record<string, unknown>;
if (globalScope[STEP_LOGGER_FLAG] !== true) {
	globalScope[STEP_LOGGER_FLAG] = true;
	main();
}
