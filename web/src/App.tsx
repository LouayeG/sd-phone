import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CallLayer } from '@/apps/phone/CallLayer';
import { NotificationHost, type NotificationItem } from '@/shell/Notifications';
import { AirShareCard, type AirShareRequest } from '@/shared/AirShare';
import { ControlCenter, ControlCenterHotzone } from '@/shell/ControlCenter';
import { MusicProvider, useMusic } from '@/apps/music/MusicContext';
import { ryDevDataHidden, ryDevToggleData } from '@/apps/ryde/data';
import { asAppId, isPreviewApp, preloadAllApps, type AppId } from '@/shell/appRegistry';
import { AppSwitcher } from '@/shell/AppSwitcher';
import { AppDeck, FullscreenStage, type DeckAppCtx } from '@/shell/AppDeck';
import { Homescreen }  from '@/shell/Homescreen';
import { useBadgeStore } from '@/stores/badgeStore';
import { useDownloadStore, useDownloadingIds } from '@/stores/downloadStore';
import { useLocaleStore } from '@/stores/localeStore';
import { HomeIndicator } from '@/shell/HomeIndicator';
import { Lockscreen }  from '@/shell/Lockscreen';
import { PhoneShell }  from '@/shell/PhoneShell';
import { StatusBar }   from '@/shell/StatusBar';
import { VolumeHUD }   from '@/shell/VolumeHUD';
import { SetupFlow }   from '@/shell/SetupFlow';
import type { SetupResult } from '@/shell/SetupFlow';
import { useNuiEvent } from '@/hooks/useNuiEvent';
import { seedSessionState } from '@/hooks/useSessionState';
import { onOpenMail, onOpenMaps, onOpenMessages } from '@/shell/deeplink';
import { fetchNui, isFiveM } from '@/core/nui';
import { setMailDomain } from '@/core/accountsApi';
import { voiceHub, setLocalTalking } from '@/media/nearbyVoice';
import { useMusicLibrary } from '@/stores/musicLibraryStore';
import { DEFAULT_FRAME_COLOR } from '@/shell/frameColors';
import { ThemeProvider, useTheme, useThemeStore } from '@/stores/themeStore';
import type { AppDef } from '@/core/types';
import { listInstalledApps, installApp, uninstallApp, loadHomeLayout, saveHomeLayout, parseLayout, type SavedLayout } from '@/apps/appstore/appsApi';
import { resolveWallpaper } from '@/shell/wallpapers';
import { playOnce } from '@/apps/settings/tonePlayer';
import { resolveTone, toneUrl } from '@/apps/settings/tones';
import { AlarmRinging, AlarmPeekBanner } from '@/apps/clock/AlarmRinging';
import { alarmsSnapshot, disableAlarm, hydrateAlarms, onTestAlarm } from '@/stores/alarmStore';
import { tmFinish, useTimer } from '@/stores/timerStore';
import { isRepeating } from '@/apps/clock/data';
import type { AlarmDef } from '@/apps/clock/data';


const SETUP_KEY = 'sd-phone:setup:v1';

interface SetupSaved {
    completed:  boolean;
    language?:  string;
    pin?:       string | null;
    faceUnlock?: boolean;
    theme?:     'light' | 'dark';
    wallpaper?: string;
}

function loadSetup(): SetupSaved {
    try {
        const raw = window.localStorage.getItem(SETUP_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as SetupSaved;
            if (parsed && typeof parsed.completed === 'boolean') return parsed;
        }
    } catch { /* ignore */ }
    return { completed: false };
}

function saveSetup(s: SetupSaved): void {
    try { window.localStorage.setItem(SETUP_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

interface ViewState {
    apps:          AppDef[];
    dock:          string[];
    wallpaperHome: string;
    wallpaperLock: string;
    carrier:       string;
    signal:        number;
    showWifi:      boolean;
    use24h:        boolean;
    showDate:      boolean;
}

const SERVER_BADGE_APPS = new Set<AppId>(['messages', 'phone', 'mail', 'groups', 'photogram']);

// How many apps the switcher shows / the recents list remembers. Every visible card
// wants a live preview, so the retain cap below is bound to this - keeping them the
// same value is what stops the extra cards from falling back to a grey icon card.
const RECENTS_CAP = 10;

// How many preview-eligible apps are kept alive (live switcher cards) at once. The
// active app is always live on top of this; anything past the cap downgrades to an
// icon card. Matched to RECENTS_CAP so every card the switcher can show is a live
// view. Safe to keep this high because backgrounded retained apps are suspended to
// ~0 CPU (see deckActive.ts + the choke-point gates in appRegistry.tsx) - the only
// remaining cost is an idle, frozen React tree per app the player actually opened.
const RETAIN_CAP = RECENTS_CAP;

const ALARM_TEST_ID = '__alarm_test__';

export function App() {
    return (
        <ThemeProvider>
            <MusicProvider>
                <AppContent />
            </MusicProvider>
        </ThemeProvider>
    );
}

function AppContent() {
    // Tone/volume fields are deliberately NOT subscribed here — they're only
    // read inside event callbacks (via useThemeStore.getState()), so slider
    // drags in Control Center don't re-render the whole tree from the root.
    const { theme, wallpaper, setTheme, setWallpaper, statusLightOverride, hideHomeIndicator, airplaneMode, hour24, setHour24, setSecurity } = useTheme('theme', 'wallpaper', 'setTheme', 'setWallpaper', 'statusLightOverride', 'hideHomeIndicator', 'airplaneMode', 'hour24', 'setHour24', 'setSecurity');
    const locale = useLocaleStore(s => s.locale);
    useEffect(() => { useLocaleStore.getState().hydrate(); }, []);

    const [view,            setView]            = useState<ViewState | null>(null);
    const [entering,        setEntering]        = useState(false);
    const [leaving,         setLeaving]         = useState(false);
    const [locked,          setLocked]          = useState<boolean>(true);
    const [flashlightOn,    setFlashlightOn]    = useState(false);
    const [homeEditing,     setHomeEditing]     = useState(false);
    const [setupHello,      setSetupHello]      = useState(true);
    const [finishingSetup,  setFinishingSetup]  = useState(false);
    const [ccOpen,          setCcOpen]          = useState(false);
    const [ccWifi,          setCcWifi]          = useState(true);
    const [unlockTrigger,   setUnlockTrigger]   = useState(0);
    const [launchTrigger,   setLaunchTrigger]   = useState(0);
    const pendingCcApp                          = useRef<string | null>(null);
    const pendingLaunchLink                     = useRef<Record<string, unknown> | undefined>(undefined);
    const [battery,         setBattery]         = useState<number>(100);
    const [currentApp,      setCurrentApp]      = useState<AppId | null>(null);
    const [launchOrigin,    setLaunchOrigin]    = useState<{ x: number; y: number } | null>(null);
    const [launchExpand,    setLaunchExpand]    = useState<boolean>(false);
    const [isClosing,       setIsClosing]       = useState(false);
    const [recentApps,      setRecentApps]      = useState<AppId[]>([]);
    // Retained keep-alive deck: preview-eligible apps foregrounded THIS phone-open
    // session, most-recent first, capped. These + the active app are the ids the
    // AppDeck keeps mounted. foregroundKeys drives per-app open-animation replays.
    const [retained,        setRetained]        = useState<AppId[]>([]);
    const [foregroundKeys,  setForegroundKeys]  = useState<Record<string, number>>({});
    const [switcherOpen,    setSwitcherOpen]    = useState(false);
    const [switcherClosing, setSwitcherClosing] = useState(false);
    const [switcherReady,   setSwitcherReady]   = useState(false);
    const [landscape,       setLandscape]       = useState(false);
    const [installedApps,   setInstalledApps]   = useState<Set<string>>(new Set());
    const [savedLayout,     setSavedLayout]     = useState<SavedLayout | null>(null);
    const [frameColor,      setFrameColor]      = useState<string>(DEFAULT_FRAME_COLOR);
    const downloadingIds = useDownloadingIds();
    const downloadQueue = useRef<string[]>([]);
    const downloadTimer = useRef<number>();

    const [setup, setSetup] = useState<SetupSaved>(() => loadSetup());
    useEffect(() => {
        if (!setup.completed) return;
        if (setup.theme) setTheme(setup.theme);
        // Wallpaper is intentionally NOT re-applied from the saved setup here. It
        // persists server-side (phone_settings) and hydrates via settings:get on
        // mount. Re-applying the localStorage setup value on every launch
        // clobbered the player's later pick with a stale asset URL — one whose
        // build hash no longer existed after a rebuild, hence a 404 / black
        // background. setWallpaper still runs once at setup completion (below).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [setup.completed]);

    function handleSetupDone(result: SetupResult) {
        const next: SetupSaved = {
            completed:  true,
            language:   result.language,
            pin:        result.pin,
            faceUnlock: result.faceUnlock,
            theme:      result.theme,
            wallpaper:  result.wallpaper,
        };
        setSetup(next);
        saveSetup(next);
        setTheme(result.theme);
        setWallpaper(result.wallpaper);
        setSecurity(result.pin, result.faceUnlock);
        setLocked(false);
        setFinishingSetup(true);
        window.setTimeout(() => setFinishingSetup(false), 520);
    }

    useEffect(() => {
        if (switcherOpen && recentApps.length === 0) {
            setSwitcherOpen(false);
            setSwitcherClosing(false);
        }
    }, [recentApps, switcherOpen]);

    useNuiEvent('sd-phone:open', useCallback((data) => {
        if (!data) return;
        if (data.locale) useLocaleStore.getState().applyServerDefault(data.locale);   // server default, unless the player already picked their own
        if (data.mailDomain) setMailDomain(data.mailDomain);
        const nextView: ViewState = {
            apps:          data.apps,
            dock:          data.dock,
            wallpaperHome: data.wallpaper.home,
            wallpaperLock: data.wallpaper.lock,
            carrier:       data.carrier,
            signal:        data.signal,
            showWifi:      data.showWifi,
            use24h:        data.use24h,
            showDate:      data.showDate,
        };
        setView(nextView);
        lastViewRef.current = nextView;
        // Reopen: the deck now lives ABOVE the shell and is never unmounted, so last
        // session's retained apps are still alive - we deliberately do NOT clear them,
        // which is what brings the switcher previews back exactly where you left them.
        // "Close All" is the only thing that wipes them (iOS: apps stay open otherwise).
        setCurrentApp(null);
        setIsClosing(false);
        setLaunchOrigin(null);
        setSwitcherOpen(false);
        setSwitcherClosing(false);
        setSwitcherReady(false);
        setNotifs([]);
        if (data.installedApps) setInstalledApps(new Set(data.installedApps));
        else void listInstalledApps().then(ids => setInstalledApps(new Set(ids)));
        setSavedLayout(data.homeLayout ? parseLayout(data.homeLayout) : loadHomeLayout());
        setLocked(data.locked);
        setBattery(data.battery);
        if (data.frameColor) setFrameColor(data.frameColor);
        setLeaving(false);
        setEntering(true);
        if (isFiveM) void fetchNui<Record<string, number>>('sd-phone:badges:get').then(m => useBadgeStore.getState().setServer(m ?? {}));
        if (isFiveM) void fetchNui<{ on: boolean }>('sd-phone:flashlight:state').then(r => setFlashlightOn(!!r?.on));
    }, []));

    useNuiEvent('sd-phone:close', useCallback(() => {
        setLeaving(true);
    }, []));

    useNuiEvent('sd-phone:frameColor', useCallback((data) => {
        if (data?.color) setFrameColor(data.color);
    }, []));

    useNuiEvent('sd-phone:music:receive', useCallback((data) => {
        if (!data) return;
        const lib = useMusicLibrary.getState();
        if (data.kind === 'track' && data.track) lib.addReceivedTracks([data.track]);
        else if (data.kind === 'playlist' && Array.isArray(data.tracks)) {
            lib.addReceivedPlaylist(data.name ?? 'Shared Playlist', data.tracks);
        }
    }, []));

    useNuiEvent('sd-phone:voice:signalIn', useCallback((data) => {
        void voiceHub.handleIncoming(data);
    }, []));

    useNuiEvent('sd-phone:voice:talkingState', useCallback((data) => {
        setLocalTalking(!!data?.on);
    }, []));

    useNuiEvent('sd-phone:wipe', useCallback(() => {
        try { localStorage.clear(); } catch { /* ignore */ }
        window.location.reload();
    }, []));

    const [radioIsland, setRadioIsland] = useState({ on: false, standby: false, freq: 0, onAir: false });
    useNuiEvent('sd-phone:radio:status', useCallback((d) => {
        setRadioIsland(s => ({
            on:      !!d.on,
            standby: !!d.standby && !d.on,
            freq:    d.freq,
            onAir:   d.on ? s.onAir : false,
        }));
    }, []));
    useNuiEvent('sd-phone:radio:onair', useCallback((d) => {
        setRadioIsland(s => ({ ...s, onAir: !!d.active }));
    }, []));

    // Bring an app to the fullscreen foreground: single mount point of truth. Bumps
    // its foreground key (replays the open animation on the retained instance) and,
    // if it is preview-eligible, promotes it into the retained keep-alive deck.
    const foreground = useCallback((id: AppId, origin: { x: number; y: number }, expand = false) => {
        setIsClosing(false);
        setLaunchOrigin(origin);
        setLaunchExpand(expand);
        setCurrentApp(id);
        setForegroundKeys(m => ({ ...m, [id]: (m[id] ?? 0) + 1 }));
        setRecentApps(prev => [id, ...prev.filter(x => x !== id)].slice(0, RECENTS_CAP));
        if (isPreviewApp(id)) {
            setRetained(prev => [id, ...prev.filter(x => x !== id)].slice(0, RETAIN_CAP));
        }
        useBadgeStore.getState().clear(id);
    }, []);

    // Reset the live deck: retained instances unmount, so their effects/subscriptions
    // stop. Called on lock / holster / Close All - "where you left off" is a per
    // phone-open concept (the deck provably cannot survive an unmount of the shell).
    const clearDeck = useCallback(() => {
        setRetained([]);
        setForegroundKeys({});
    }, []);

    const launchApp = useCallback((app: AppDef, origin: { x: number; y: number }) => {
        void fetchNui('sd-phone:openApp', { id: app.id, route: app.route });
        const id = asAppId(app.id);
        if (id) foreground(id, origin);
    }, [foreground]);

    const handleCloseApp = useCallback(() => {
        // Close is purely: play the ios-app-close collapse, then unmount. NO html2canvas anywhere on
        // this path (nor deferred to idle, which still blocks the same thread a beat later) - the
        // synchronous rasterize is what froze the phone and left the collapsed speck stuck on screen.
        // Snapshots are taken only when swiping up into the switcher, masked by its cover animation.
        setIsClosing(true);
    }, []);

    const closePhone = useCallback(() => {
        void fetchNui('sd-phone:close');
        setLeaving(true);
    }, []);

    // Called by the deck when the active app's close-collapse settles. The retained
    // instance is NOT unmounted here - it stays alive in the deck's hidden pool (if
    // preview-eligible) or is dropped from deckIds (if not). Either way: no capture,
    // no rasterize, so hover/click are live the instant the collapse ends.
    const handleAnimEnd = useCallback(() => {
        setCurrentApp(null);
        setIsClosing(false);
        setLaunchOrigin(null);
    }, []);

    const handleShowSwitcher = useCallback(() => {
        // No capture, no rasterize. The switcher shows real retained live views (the
        // active app's card is the SAME instance re-parented, so it's live at once);
        // switcherReady gates the staggered reveal of the other retained cards until
        // after the open animation settles.
        setSwitcherReady(false);
        setSwitcherOpen(prev => (prev ? prev : true));
    }, []);

    const handleSwitcherDismiss  = useCallback(() => setSwitcherClosing(true), []);
    const handleSwitcherReady    = useCallback(() => setSwitcherReady(true), []);
    const handleSwitcherDone     = useCallback(() => {
        if (!switcherClosing) return;
        setSwitcherOpen(false);
        setSwitcherClosing(false);
        setSwitcherReady(false);
    }, [switcherClosing]);

    const applyNotifLink = useCallback((link?: Record<string, unknown>) => {
        if (link) for (const [k, v] of Object.entries(link)) seedSessionState(k, v);
    }, []);

    const handleOpenFromSwitcher = useCallback((id: AppId, origin: { x: number; y: number }) => {
        // Opening from an OPEN switcher card grows the app out of that near-fullscreen
        // preview (ios-app-expand); notification / deeplink opens (switcher closed) keep
        // the normal home-launch pop.
        const fromSwitcher = switcherOpen;
        setSwitcherOpen(false);
        setSwitcherClosing(false);
        setSwitcherReady(false);
        foreground(id, origin, fromSwitcher);
    }, [foreground, switcherOpen]);

    const openAppById = useCallback((id: string | null | undefined, origin: { x: number; y: number }) => {
        const app = asAppId(id);
        if (app) handleOpenFromSwitcher(app, origin);
    }, [handleOpenFromSwitcher]);

    const openAppCentered = useCallback((id: string) => openAppById(id, { x: 0.5, y: 0.5 }), [openAppById]);

    // The exact set of app ids the deck keeps mounted: the active app (always) plus
    // the retained preview-eligible apps. Order is active-first for reveal priority.
    const deckIds = useMemo<AppId[]>(() => {
        const ids: AppId[] = [];
        if (currentApp) ids.push(currentApp);
        for (const id of retained) if (!ids.includes(id)) ids.push(id);
        return ids;
    }, [currentApp, retained]);

    const music = useMusic();
    useEffect(() => {
        if (music.openSignal === 0) return;
        setLocked(false);
        handleOpenFromSwitcher('music', { x: 0.5, y: 0.08 });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [music.openSignal]);

    useEffect(() => onOpenMaps(() => {
        setLocked(false);
        handleOpenFromSwitcher('maps', { x: 0.5, y: 0.5 });
    }), [handleOpenFromSwitcher]);

    useEffect(() => onOpenMessages(() => {
        setLocked(false);
        handleOpenFromSwitcher('messages', { x: 0.5, y: 0.5 });
    }), [handleOpenFromSwitcher]);

    useEffect(() => onOpenMail(() => {
        setLocked(false);
        handleOpenFromSwitcher('mail', { x: 0.5, y: 0.5 });
    }), [handleOpenFromSwitcher]);

    const handleRemoveFromRecents = useCallback((id: string) => {
        setRecentApps(prev => prev.filter(x => x !== id));
        setRetained(prev => prev.filter(x => x !== id));
        setForegroundKeys(m => { const n = { ...m }; delete n[id]; return n; });
        setCurrentApp(prev => {
            if (prev === id) {
                setIsClosing(false);
                setLaunchOrigin(null);
                return null;
            }
            return prev;
        });
    }, []);

    const handleRemoveAll = useCallback(() => {
        setRecentApps([]);
        setCurrentApp(null);
        setIsClosing(false);
        setLaunchOrigin(null);
        setSwitcherOpen(false);
        setSwitcherClosing(false);
        setSwitcherReady(false);
        clearDeck();
    }, [clearDeck]);

    const finishInstall = useCallback((id: string) => {
        setInstalledApps(prev => new Set(prev).add(id));
        void installApp(id).then(ids => setInstalledApps(new Set(ids)));
    }, []);
    const pumpDownloads = useCallback(function pump() {
        const id = downloadQueue.current[0];
        if (id === undefined) { downloadTimer.current = undefined; return; }
        useDownloadStore.getState().start(id, false);
        const DURATION = 4000;
        const start = performance.now();
        const step = () => {
            const p = Math.min(1, (performance.now() - start) / DURATION);
            useDownloadStore.getState().setProgress(id, p);
            if (p >= 1) {
                clearInterval(downloadTimer.current);
                downloadTimer.current = undefined;
                finishInstall(id);
                useDownloadStore.getState().remove(id);
                downloadQueue.current = downloadQueue.current.slice(1);
                pump();
            }
        };
        downloadTimer.current = window.setInterval(step, 50);
    }, [finishInstall]);
    const startDownload = useCallback((id: string) => {
        if (downloadQueue.current.includes(id)) return;
        const wasIdle = downloadQueue.current.length === 0;
        downloadQueue.current = [...downloadQueue.current, id];
        useDownloadStore.getState().start(id, !wasIdle);
        if (wasIdle) pumpDownloads();
    }, [pumpDownloads]);
    const handleUninstallApp = useCallback((id: string) => {
        setInstalledApps(prev => { const n = new Set(prev); n.delete(id); return n; });
        void uninstallApp(id).then(ids => setInstalledApps(new Set(ids)));
    }, []);
    const handleSaveLayout = useCallback((layout: SavedLayout) => {
        saveHomeLayout(layout);
    }, []);

    // Stable-ish context handed to every deck app instance. Memoized so unrelated
    // App re-renders (notifications, battery, island state) don't rebuild app nodes;
    // it only changes when the app list / install set / stable callbacks change.
    const deckCtx = useMemo<DeckAppCtx>(() => ({
        onClose:           handleCloseApp,
        allApps:           view?.apps ?? [],
        installedApps,
        onInstall:         startDownload,
        onOpenApp:         openAppCentered,
        onLandscapeChange: setLandscape,
    }), [handleCloseApp, view, installedApps, startDownload, openAppCentered]);

    useEffect(() => () => {
        if (downloadTimer.current !== undefined) clearInterval(downloadTimer.current);
    }, []);

    useNuiEvent('sd-phone:battery', useCallback((pct) => {
        if (typeof pct === 'number') setBattery(pct);
    }, []));

    const [notifs, setNotifs] = useState<NotificationItem[]>([]);
    const [lockNotifs, setLockNotifs] = useState<NotificationItem[]>([]);
    const [peek, setPeek] = useState<'in' | 'out' | null>(null);
    const [peekNotif, setPeekNotif] = useState<NotificationItem | null>(null);
    const peekTimer = useRef<number | undefined>(undefined);
    const [ringingAlarm, setRingingAlarm] = useState<AlarmDef | null>(null);
    const ringingAlarmRef = useRef(ringingAlarm);
    ringingAlarmRef.current = ringingAlarm;
    const [ringingSince, setRingingSince] = useState(0);
    const lastViewRef  = useRef<ViewState | null>(null);
    const phoneOpenRef = useRef(false);
    phoneOpenRef.current = !!view;
    const lockedRef = useRef(locked);
    lockedRef.current = locked;
    useNuiEvent('sd-phone:badges', useCallback((data) => {
        useBadgeStore.getState().setServer(data ?? {});
    }, []));
    useEffect(() => {
        if (currentApp === 'phone') void fetchNui('sd-phone:calls:seen');
    }, [currentApp]);
    const currentAppRef = useRef(currentApp);
    currentAppRef.current = currentApp;
    useNuiEvent('sd-phone:notification', useCallback((data) => {
        const target = data.appId ?? data.app;
        if (data.quietInApp && target && target === currentAppRef.current) return;
        const item: NotificationItem = {
            ...data,
            id: data.id ?? `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        };
        if (phoneOpenRef.current && !lockedRef.current) {
            setNotifs(prev => [item, ...prev.filter(n => n.id !== item.id)].slice(0, 4));
        }
        setLockNotifs(prev => [item, ...prev.filter(n => n.id !== item.id)].slice(0, 5));
        if (!phoneOpenRef.current && !ringingAlarmRef.current) {
            setPeekNotif(item);
            setPeek('in');
            if (peekTimer.current) window.clearTimeout(peekTimer.current);
            peekTimer.current = window.setTimeout(() => setPeek('out'), 4200);
        }
        const badgeTarget = asAppId(target);
        if (badgeTarget && badgeTarget !== currentAppRef.current && !SERVER_BADGE_APPS.has(badgeTarget)) {
            useBadgeStore.getState().bump(badgeTarget);
        }
        const tones = useThemeStore.getState();
        playOnce(resolveTone('notification', tones.notificationTone, tones.customNotificationTones).url, tones.ringtoneVol / 100);
    }, []));
    const removeNotif = useCallback((id: string) => setNotifs(prev => prev.filter(n => n.id !== id)), []);
    const toggleFlashlight = useCallback(() => {
        setFlashlightOn(prev => !prev);
        void fetchNui<{ on: boolean }>('sd-phone:flashlight:toggle').then(r => {
            if (r && typeof r.on === 'boolean') setFlashlightOn(r.on);
        });
    }, []);
    const openCameraFromLock = useCallback(() => {
        setLocked(false);
        handleOpenFromSwitcher('camera', { x: 0.5, y: 0.92 });
    }, [handleOpenFromSwitcher]);
    const launchPendingApp = useCallback(() => {
        setLocked(false);
        const id = pendingCcApp.current;
        const link = pendingLaunchLink.current;
        pendingCcApp.current = null;
        pendingLaunchLink.current = undefined;
        applyNotifLink(link);
        openAppById(id, { x: 0.5, y: 0.5 });
    }, [openAppById, applyNotifLink]);
    const openLockNotif = useCallback((item: NotificationItem) => {
        setLockNotifs(prev => prev.filter(n => n.id !== item.id));
        setLocked(false);
        const target = item.appId ?? item.app;
        if (target) { applyNotifLink(item.link); openAppById(target, { x: 0.5, y: 0.4 }); }
    }, [openAppById, applyNotifLink]);
    const dismissLockNotif = useCallback((id: string) => {
        setLockNotifs(prev => prev.filter(n => n.id !== id));
    }, []);
    useNuiEvent('sd-phone:launchApp', useCallback((data) => {
        const id = asAppId(data?.id);
        if (!id || !setup.completed) return;
        if (lockedRef.current) {
            pendingCcApp.current = id;
            pendingLaunchLink.current = data.link;
            setLaunchTrigger(n => n + 1);
        } else {
            applyNotifLink(data.link);
            openAppById(id, { x: 0.5, y: 0.5 });
        }
    }, [setup.completed, applyNotifLink, openAppById]));
    useEffect(() => {
        if (peek !== 'out') return;
        const t = window.setTimeout(() => setPeek(null), 440);
        return () => window.clearTimeout(t);
    }, [peek]);
    useEffect(() => {
        if (view) { setPeek(null); setPeekNotif(null); if (peekTimer.current) window.clearTimeout(peekTimer.current); }
    }, [view]);

    useEffect(() => { hydrateAlarms(); }, []);
    const phoneOpen = !!view;
    useEffect(() => { if (phoneOpen) hydrateAlarms(true); }, [phoneOpen]);

    const fireAlarm = useCallback((a: AlarmDef) => {
        if (ringingAlarmRef.current) return;
        setRingingAlarm(a);
        setRingingSince(Date.now());
    }, []);

    const snoozeTimerRef = useRef<number | null>(null);

    const dismissAlarm = useCallback((keep: boolean) => {
        const a = ringingAlarmRef.current;
        setRingingAlarm(null);
        setPeek(null);
        setPeekNotif(null);
        if (peekTimer.current) window.clearTimeout(peekTimer.current);
        if (snoozeTimerRef.current) { window.clearTimeout(snoozeTimerRef.current); snoozeTimerRef.current = null; }
        if (!keep && a && a.id !== ALARM_TEST_ID && !isRepeating(a)) disableAlarm(a.id);
    }, []);

    const snoozeAlarm = useCallback(() => {
        const a = ringingAlarmRef.current;
        setRingingAlarm(null);
        setPeek(null);
        setPeekNotif(null);
        if (peekTimer.current) window.clearTimeout(peekTimer.current);
        if (!a) return;
        const secs = a.snoozeSecs && a.snoozeSecs > 0 ? a.snoozeSecs : 60;
        if (snoozeTimerRef.current) window.clearTimeout(snoozeTimerRef.current);
        snoozeTimerRef.current = window.setTimeout(() => fireAlarm(a), secs * 1000);
    }, [fireAlarm]);

    useEffect(() => {
        if (!ringingAlarm || ringingAlarm.sound === false) return;
        const tones = useThemeStore.getState();
        const audio = new Audio(toneUrl('ringtone', tones.ringtone));
        audio.loop = true;
        audio.volume = Math.max(0, Math.min(1, tones.ringtoneVol / 100));
        void audio.play().catch(() => { /* autoplay may need a prior gesture */ });
        return () => { audio.pause(); };
    }, [ringingAlarm]);

    useEffect(() => {
        if (ringingAlarm && !phoneOpen) {
            if (peekTimer.current) window.clearTimeout(peekTimer.current);
            setPeek('in');
        }
    }, [ringingAlarm, phoneOpen]);

    const COOLDOWN_MS = 60_000;
    const lastFiredRef = useRef<Record<string, number>>({});
    useEffect(() => {
        const tick = () => {
            if (ringingAlarmRef.current) return;
            const now = new Date();
            const h = now.getHours(), m = now.getMinutes();
            const ms = now.getTime();
            const due = alarmsSnapshot().find(a =>
                a.enabled && a.hour === h && a.minute === m && ms - (lastFiredRef.current[a.id] ?? 0) > COOLDOWN_MS);
            if (due) { lastFiredRef.current[due.id] = ms; fireAlarm(due); }
        };
        const id = window.setInterval(tick, 5000);
        return () => window.clearInterval(id);
    }, [fireAlarm]);

    useEffect(() => onTestAlarm(() => {
        fireAlarm({ id: ALARM_TEST_ID, hour: 0, minute: 0, label: 'Test Alarm', days: '', enabled: true });
    }), [fireAlarm]);

    const { status: timerStatus, endsAt: timerEndsAt } = useTimer();
    const onTimerComplete = useCallback(() => {
        tmFinish();
        if (currentAppRef.current === 'clock') {
            const tones = useThemeStore.getState();
            playOnce(resolveTone('notification', tones.notificationTone, tones.customNotificationTones).url, tones.ringtoneVol / 100);
        } else {
            window.postMessage({ action: 'sd-phone:notification', data: { app: 'clock', appId: 'clock', title: 'Timer', body: 'Your timer has been completed' } }, '*');
        }
    }, []);
    useEffect(() => {
        if (timerStatus !== 'running') return;
        const delay = timerEndsAt - Date.now();
        if (delay <= 0) { onTimerComplete(); return; }
        const id = window.setTimeout(onTimerComplete, delay);
        return () => window.clearTimeout(id);
    }, [timerStatus, timerEndsAt, onTimerComplete]);

    const [airshare, setAirshare] = useState<AirShareRequest[]>([]);
    useNuiEvent('sd-phone:airshare', useCallback((data) => {
        setAirshare(prev => (prev.some(r => r.id === data.id) ? prev : [...prev, data]));
    }, []));
    const respondAirshare = useCallback((id: string, accept: boolean) => {
        void fetchNui('sd-phone:airshare:respond', { id, accept });
        setAirshare(prev => prev.filter(r => r.id !== id));
    }, []);

    const warmedImages = useRef<Map<string, HTMLImageElement>>(new Map());
    const warmImage = useCallback((src: string) => {
        if (!src || warmedImages.current.has(src)) return;
        const img = new Image();
        img.src = src;
        void img.decode?.().catch(() => { /* decode race / unsupported — ignore */ });
        warmedImages.current.set(src, img);
    }, []);

    useEffect(() => {
        if (wallpaper) warmImage(resolveWallpaper(wallpaper));
    }, [wallpaper, warmImage]);

    useEffect(() => {
        if (!entering) return;
        const t = window.setTimeout(() => setEntering(false), 560);
        return () => window.clearTimeout(t);
    }, [entering]);

    useEffect(() => {
        if (!leaving) return;
        const t = window.setTimeout(() => {
            setView(null);
            setLeaving(false);
            setEntering(false);
            setCurrentApp(null);
            setIsClosing(false);
            setLaunchOrigin(null);
            setSwitcherOpen(false);
            setSwitcherClosing(false);
            setSwitcherReady(false);
            // retained / foregroundKeys are intentionally kept: the deck outlives this
            // teardown, so the apps stay mounted (suspended) and reappear on reopen.
        }, 440);
        return () => window.clearTimeout(t);
    }, [leaving]);

    // Locking no longer tears the deck down (it lives above the shell and we force every
    // app to suspend while locked, see deckActiveId). Keep retained/foregroundKeys so the
    // switcher previews survive a lock/unlock; just make sure no stale switcher lingers.
    useEffect(() => {
        if (locked) setSwitcherReady(false);
    }, [locked]);

    useEffect(() => {
        if (isFiveM) return;
        let cancel: (() => void) | undefined;
        void import('@/core/dev').then(mod => { cancel = mod.devInjectMockData(); });
        return () => cancel?.();
    }, []);

    // Warm the app chunks only once the phone has actually been opened — the
    // NUI page mounts at player JOIN, and parsing ~3.6MB of lazy chunks during
    // the spawn window is wasted work for players who never take the phone out.
    const preloadArmed = useRef(false);
    useEffect(() => {
        if (!view || preloadArmed.current) return;
        preloadArmed.current = true;
        const t = window.setTimeout(preloadAllApps, 1500);
        return () => window.clearTimeout(t);
    }, [view]);

    useEffect(() => {
        if (isFiveM) return;
        (window as unknown as { __sdShoot?: unknown }).__sdShoot = {
            open: (id: string) => { setLocked(false); openAppById(id, { x: 0.5, y: 0.5 }); },
            squareScreen: () => {
                const el = document.querySelector('[data-phone-screen]') as HTMLElement | null;
                if (!el) return;
                el.style.borderRadius = '0';
                el.style.clipPath = 'none';
                el.style.setProperty('-webkit-clip-path', 'none');
                el.style.maskImage = 'none';
                el.style.setProperty('-webkit-mask-image', 'none');
            },
        };
    }, [openAppById]);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            const tgt = e.target as HTMLElement | null;
            const typing = !!tgt && (
                tgt.tagName === 'INPUT'
                || tgt.tagName === 'TEXTAREA'
                || tgt.isContentEditable
            );

            if (e.key === 'Escape') {
                if (switcherOpen)            { handleSwitcherDismiss(); return; }
                if (currentApp && !isClosing) { handleCloseApp();        return; }
                void fetchNui('sd-phone:close');
                setLeaving(true);
            }
            if ((e.key === 'l' || e.key === 'L') && !locked && !typing) {
                setLocked(true);
                setCurrentApp(null);
                setIsClosing(false);
                setLaunchOrigin(null);
                setSwitcherOpen(false);
                setSwitcherClosing(false);
            }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [locked, currentApp, isClosing, switcherOpen, handleCloseApp, handleSwitcherDismiss]);

    useEffect(() => {
        if (!isFiveM) return;
        const isText = (el: EventTarget | null) => {
            const t = el as HTMLElement | null;
            return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        };
        const onFocus = (e: FocusEvent) => { if (isText(e.target)) void fetchNui('sd-phone:typing', { typing: true }); };
        const onBlur  = (e: FocusEvent) => { if (isText(e.target)) void fetchNui('sd-phone:typing', { typing: false }); };
        document.addEventListener('focusin', onFocus);
        document.addEventListener('focusout', onBlur);
        return () => {
            document.removeEventListener('focusin', onFocus);
            document.removeEventListener('focusout', onBlur);
        };
    }, []);

    // The keep-alive deck is rendered ABOVE the shell (in both the closed and open
    // branches, under a stable key) so it is never unmounted by a holster/lock/locale
    // change - that persistence is what lets the switcher previews survive the phone
    // being put away. While holstered (no view) or locked, deckActiveId is null so the
    // active app drops to the deck's hidden pool and every app suspends to ~0 CPU.
    const deckActiveId = (!view || locked) ? null : currentApp;
    const deckLayer = (
        <div key="deck-root" className={theme === 'dark' ? 'dark' : undefined}>
            <AppDeck
                deckIds={deckIds}
                activeId={deckActiveId}
                switcherOpen={switcherOpen}
                switcherReady={switcherReady}
                closing={isClosing}
                foregroundKeys={foregroundKeys}
                launchOrigin={launchOrigin}
                launchExpand={launchExpand}
                ctx={deckCtx}
                onCloseDone={handleAnimEnd}
            />
        </div>
    );

    if (!view) {
        const lv = lastViewRef.current;
        const peekWall = resolveWallpaper(wallpaper || lv?.wallpaperLock || 'lockscreen.jpg');
        return (
            <>
                {deckLayer}
                <div key="shell-closed" className={theme === 'dark' ? 'dark' : undefined}>
                {peek && (
                    <PhoneShell peek={peek} frameColor={frameColor} radioIsland={radioIsland} alarmIsland={{ ringing: !!ringingAlarm, since: ringingSince }}>
                        <div className="wallpaper absolute inset-0" style={{ backgroundImage: `url(${peekWall})` }} />
                        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/30 via-black/5 to-transparent" />
                        <StatusBar
                            use24h={hour24}
                            signal={airplaneMode ? 0 : (lv?.signal ?? 4)}
                            showWifi={airplaneMode ? false : ((lv?.showWifi ?? true) && ccWifi)}
                            battery={battery}
                            airplane={airplaneMode}
                            light
                        />
                        {ringingAlarm ? (
                            <AlarmPeekBanner name={ringingAlarm.label} since={ringingSince} />
                        ) : (
                            <NotificationHost
                                items={peekNotif ? [peekNotif] : []}
                                placement="phone"
                                onDismiss={() => setPeekNotif(null)}
                                onOpen={() => setPeekNotif(null)}
                            />
                        )}
                    </PhoneShell>
                )}
                </div>
            </>
        );
    }

    const statusLight = locked || !currentApp || theme === 'dark';
    const activeWallpaper = wallpaper || view.wallpaperHome;

    const allApps       = view.apps;
    const effectiveApps = allApps.filter(a => a.base || installedApps.has(a.id) || downloadingIds.includes(a.id));
    const effectiveIds  = new Set(effectiveApps.map(a => a.id));

    const canShowSwitcher = recentApps.length > 0 || !!currentApp;

    const showSetup = !setup.completed;

    const cameraMode = currentApp === 'camera' && !isClosing && !locked;

    const onHomescreen = !showSetup && !locked && !currentApp;

    return (
        <>
        {deckLayer}
        <div key={showSetup ? 'setup' : locale} className={theme === 'dark' ? 'dark' : undefined}>
            {import.meta.env.DEV && (
                <button
                    type="button"
                    onClick={() => setSetup(prev => { const next = { ...prev, completed: !prev.completed }; saveSetup(next); return next; })}
                    className="fixed left-3 top-3 z-[99999] rounded-md bg-black/70 px-2.5 py-1 text-[11px] font-semibold text-white ring-1 ring-white/20 hover:bg-black/90"
                >
                    {showSetup ? 'Exit Setup' : 'Show Setup'}
                </button>
            )}
            {import.meta.env.DEV && (
                <button
                    type="button"
                    onClick={() => { ryDevToggleData(); window.location.reload(); }}
                    className="fixed left-3 top-12 z-[99999] rounded-md bg-black/70 px-2.5 py-1 text-[11px] font-semibold text-white ring-1 ring-white/20 hover:bg-black/90"
                >
                    {ryDevDataHidden() ? 'Ryde data: off' : 'Ryde data: on'}
                </button>
            )}
            {import.meta.env.DEV && (
                <button
                    type="button"
                    onClick={() => setHour24(!hour24)}
                    className="fixed left-3 top-[84px] z-[99999] rounded-md bg-black/70 px-2.5 py-1 text-[11px] font-semibold text-white ring-1 ring-white/20 hover:bg-black/90"
                >
                    {hour24 ? '24h: on' : '24h: off'}
                </button>
            )}
            <PhoneShell cameraActive={cameraMode} landscape={cameraMode && landscape} entering={entering} leaving={leaving} onClose={closePhone} frameColor={frameColor} radioIsland={radioIsland} alarmIsland={{ ringing: !!ringingAlarm, since: ringingSince }}>
                {!(showSetup && setupHello) && (
                    <StatusBar
                        use24h={hour24}
                        signal={airplaneMode ? 0 : view.signal}
                        showWifi={airplaneMode ? false : (view.showWifi && ccWifi)}
                        battery={battery}
                        airplane={airplaneMode}
                        light={showSetup ? false : (statusLightOverride ?? (cameraMode ? true : statusLight))}
                        controlHint={!showSetup && !cameraMode && !ccOpen && !homeEditing}
                        editing={homeEditing && onHomescreen}
                    />
                )}
                <VolumeHUD suppressed={ccOpen} />

                {showSetup ? (
                    <SetupFlow onDone={handleSetupDone} onHelloChange={setSetupHello} />
                ) : locked ? (
                    <Lockscreen
                        use24h={hour24}
                        showDate={view.showDate}
                        wallpaper={activeWallpaper}
                        unlockTrigger={unlockTrigger}
                        onUnlock={() => setLocked(false)}
                        launchTrigger={launchTrigger}
                        onLaunch={launchPendingApp}
                        notifications={lockNotifs}
                        onOpenNotif={openLockNotif}
                        onDismissNotif={dismissLockNotif}
                        flashlightOn={flashlightOn}
                        onToggleFlashlight={toggleFlashlight}
                        onOpenCamera={openCameraFromLock}
                    />
                ) : (
                    !cameraMode && (
                        <Homescreen
                            apps={effectiveApps}
                            dock={view.dock}
                            wallpaper={activeWallpaper}
                            onLaunchApp={launchApp}
                            onUninstall={handleUninstallApp}
                            savedLayout={savedLayout}
                            onLayoutChange={handleSaveLayout}
                            onEditingChange={setHomeEditing}
                        />
                    )
                )}

                {/* The active app renders here: this only registers the fullscreen slot;
                    the actual live instance is re-parented in from the top-level deck. */}
                {!showSetup && !locked && <FullscreenStage />}

                {!showSetup && switcherOpen && !locked && (
                    <AppSwitcher
                        apps={effectiveApps}
                        recents={canShowSwitcher
                            ? (currentApp
                                ? [currentApp, ...recentApps.filter(id => id !== currentApp)].slice(0, RECENTS_CAP)
                                : recentApps
                              ).filter(id => effectiveIds.has(id))
                            : []}
                        closing={switcherClosing}
                        onDone={handleSwitcherDone}
                        onReady={handleSwitcherReady}
                        onOpen={(id, origin) => openAppById(id, origin)}
                        onRemove={handleRemoveFromRecents}
                        onRemoveAll={handleRemoveAll}
                        onDismiss={handleSwitcherDismiss}
                    />
                )}

                {!showSetup && !locked && (
                    <SwipeHomeZone
                        hasOpenApp={!!currentApp}
                        onGoHome={handleCloseApp}
                        onShowSwitcher={canShowSwitcher ? handleShowSwitcher : undefined}
                    />
                )}

                {!onHomescreen && !showSetup && !hideHomeIndicator && (
                    <HomeIndicator
                        onGoHome={
                            locked        ? () => setUnlockTrigger(n => n + 1)
                                : currentApp  ? handleCloseApp
                                : undefined
                        }
                        closing={isClosing}
                    />
                )}

                <CallLayer wallpaper={activeWallpaper} />

                {ringingAlarm && (
                    <div className="absolute inset-0 z-30">
                        <AlarmRinging
                            name={ringingAlarm.label}
                            onStop={() => dismissAlarm(false)}
                            onKeep={() => dismissAlarm(true)}
                            canSnooze={!!ringingAlarm.snooze}
                            onSnooze={snoozeAlarm}
                            repeating={isRepeating(ringingAlarm)}
                        />
                    </div>
                )}

                {!locked && (
                    <NotificationHost
                        items={notifs}
                        placement="phone"
                        onDismiss={removeNotif}
                        onOpen={(it) => {
                            removeNotif(it.id);
                            const target = it.appId ?? it.app;
                            if (target && !showSetup) { applyNotifLink(it.link); openAppById(target, { x: 0.5, y: 0.1 }); }
                        }}
                    />
                )}

                {airshare[0] && (
                    <div className="absolute inset-x-0 top-[10px] z-[58] px-3">
                        <AirShareCard request={airshare[0]} onRespond={(a) => respondAirshare(airshare[0]!.id, a)} />
                    </div>
                )}

                {!showSetup && (
                    <>
                        {!ccOpen && !homeEditing && <ControlCenterHotzone onOpen={() => setCcOpen(true)} />}
                        <ControlCenter
                            open={ccOpen}
                            onClose={() => setCcOpen(false)}
                            onOpenApp={id => {
                                if (locked) { pendingCcApp.current = id; pendingLaunchLink.current = undefined; setLaunchTrigger(n => n + 1); }
                                else openAppById(id, { x: 0.5, y: 0.5 });
                            }}
                            onWifi={setCcWifi}
                        />
                    </>
                )}

                {finishingSetup && (
                    <div className="animate-finish-veil pointer-events-none absolute inset-0 z-[250] bg-white dark:bg-black" />
                )}
            </PhoneShell>
        </div>
        </>
    );
}




interface SwipeHomeZoneProps {
    hasOpenApp:     boolean;
    onGoHome:       () => void;
    onShowSwitcher: (() => void) | undefined;
}

function SwipeHomeZone({ hasOpenApp, onGoHome, onShowSwitcher }: SwipeHomeZoneProps) {
    const startY = useRef(0);
    const startT = useRef(0);
    const fired  = useRef(false);

    return (
        <div
            className="absolute inset-x-0 bottom-0 z-50"
            style={{ height: 44, touchAction: 'none' }}
            onPointerDown={e => {
                startY.current = e.clientY;
                startT.current = Date.now();
                fired.current  = false;
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={e => {
                if (fired.current) return;
                const dy = startY.current - e.clientY;
                if (dy < 55) return;

                fired.current = true;
                const elapsed = Date.now() - startT.current;

                if (hasOpenApp && elapsed < 200) {
                    onGoHome();
                } else if (onShowSwitcher) {
                    onShowSwitcher();
                } else {
                    onGoHome();
                }
            }}
        />
    );
}
