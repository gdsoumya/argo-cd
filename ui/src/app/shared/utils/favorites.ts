import {services} from '../services';

const VIEW_PREFS_KEY = 'view_preferences';

function safeParse<T = any>(json: string | null): T | null {
    try {
        return (json && JSON.parse(json)) as T;
    } catch {
        return null;
    }
}

export function getLatestFavoritesFromStorage(): string[] {
    const raw = window.localStorage.getItem(VIEW_PREFS_KEY);
    const parsed = safeParse(raw) as any;
    const arr: string[] = (parsed?.appList?.favoritesAppUids as string[]) || [];
    return Array.from(new Set(arr.filter(x => !!x && typeof x === 'string')));
}

export function getLatestShowFavoritesFromStorage(defaultVal: boolean): boolean {
    const raw = window.localStorage.getItem(VIEW_PREFS_KEY);
    const parsed = safeParse(raw) as any;
    const val = parsed?.appList?.showFavorites;
    return typeof val === 'boolean' ? val : !!defaultVal;
}

export function updateFavoritesInPrefs(pref: any, favorites: string[]) {
    services.viewPreferences.updatePreferences({
        appList: {
            ...pref,
            favoritesAppUids: Array.from(new Set((favorites || []).filter(x => !!x)))
        }
    });
}

export function toggleFavoriteUid(uid: string, pref: any) {
    if (!uid) {
        return;
    }
    const current = getLatestFavoritesFromStorage();
    const next = current.includes(uid) ? current.filter(x => x !== uid) : [...current, uid];
    updateFavoritesInPrefs(pref, next);
}

export function preserveFavoritesAndSwitchView(pref: any, view: 'tiles' | 'list' | 'summary') {
    const favorites = getLatestFavoritesFromStorage();
    const showFav = getLatestShowFavoritesFromStorage(!!pref.showFavorites);
    services.viewPreferences.updatePreferences({
        appList: {
            ...pref,
            favoritesAppUids: favorites,
            showFavorites: !!showFav,
            view
        }
    });
}
