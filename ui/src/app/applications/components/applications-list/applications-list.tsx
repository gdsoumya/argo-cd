import {Autocomplete, ErrorNotification, MockupList, NotificationType, SlidingPanel, Tooltip} from 'argo-ui';
import classNames from 'classnames';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import {Key, KeybindingContext, KeybindingProvider} from 'argo-ui/v2';
import {RouteComponentProps} from 'react-router';
import {BehaviorSubject, combineLatest, from, merge, Observable} from 'rxjs';
import {bufferTime, delay, filter, map, mergeMap, repeat, retryWhen} from 'rxjs/operators';
import {ClusterCtx, DataLoader, EmptyState, Page, Paginate, Spinner} from '../../../shared/components';
import {AuthSettingsCtx, Consumer, ContextApis} from '../../../shared/context';
import * as models from '../../../shared/models';
import {AppsListViewKey, AppsListPreferences, AppSetsListPreferences, AppsListViewType, HealthStatusBarPreferences, services, AppsQuery} from '../../../shared/services';
import {ApplicationCreatePanel} from '../application-create-panel/application-create-panel';
import {ApplicationSyncPanel} from '../application-sync-panel/application-sync-panel';
import {ApplicationsSyncPanel} from '../applications-sync-panel/applications-sync-panel';
import * as AppUtils from '../utils';
import {ApplicationsFilter, AppSetsFilter, ApplicationSetFilteredApp, getAppSetFilterResults} from './applications-filter';
import {AppSetsStatusBar} from './applications-status-bar';
import {ApplicationsStatusBar} from './applications-status-bar';
import {ApplicationsSummary} from './applications-summary';
import {ApplicationsTable} from './applications-table';
import {ApplicationTiles} from './applications-tiles';
import {ApplicationsRefreshPanel} from '../applications-refresh-panel/applications-refresh-panel';
import {FlexTopBar} from './flex-top-bar';
import {useSidebarTarget} from '../../../sidebar/sidebar';
import {useQuery, useObservableQuery} from '../../../shared/hooks/query';
import {preserveFavoritesAndSwitchView} from '../../../shared/utils/favorites';

import './applications-list.scss';

const EVENTS_BUFFER_TIMEOUT = 500;
const WATCH_RETRY_TIMEOUT = 500;

// The applications list/watch API supports only selected set of fields.
// Make sure to register any new fields in the `appFields` map of `pkg/apiclient/application/forwarder_overwrite.go`.
const APP_FIELDS = [
    'metadata.name',
    'metadata.namespace',
    'metadata.uid',
    'metadata.annotations',
    'metadata.labels',
    'metadata.creationTimestamp',
    'metadata.deletionTimestamp',
    'spec',
    'operation.sync',
    'status.sourceHydrator',
    'status.sync.status',
    'status.sync.revision',
    'status.health',
    'status.operationState.phase',
    'status.operationState.finishedAt',
    'status.operationState.operation.sync',
    'status.summary',
    'status.resources'
];
const APP_LIST_FIELDS = ['metadata.resourceVersion', ...APP_FIELDS.map(field => `items.${field}`)];
const APP_WATCH_FIELDS = ['result.type', ...APP_FIELDS.map(field => `result.application.${field}`)];

// ApplicationSet has different status fields than Application
const APPSET_FIELDS = [
    'metadata.name',
    'metadata.namespace',
    'metadata.annotations',
    'metadata.labels',
    'metadata.creationTimestamp',
    'metadata.deletionTimestamp',
    'spec',
    'status.conditions',
    'status.resources',
    'status.resourcesCount',
    'status.health'
];
const APPSET_LIST_FIELDS = ['metadata.resourceVersion', ...APPSET_FIELDS.map(field => `items.${field}`)];
const APPSET_WATCH_FIELDS = ['result.type', ...APPSET_FIELDS.map(field => `result.applicationSet.${field}`)];

function loadApplications(q: AppsQuery, objectListKind: string): Observable<{applications: models.AbstractApplication[]; stats: models.ApplicationListStats}> {
    const reloadStats = new BehaviorSubject<Date>(new Date());
    const isApplication = objectListKind === 'application';
    const listFields = isApplication ? APP_LIST_FIELDS : APPSET_LIST_FIELDS;
    const watchFields = isApplication ? APP_WATCH_FIELDS : APPSET_WATCH_FIELDS;
    return from(services.applications.list(objectListKind, {...q, fields: listFields})).pipe(
        mergeMap(applicationsList => {
            const applications = applicationsList.items;
            let minName: string = null;
            let maxName: string = null;
            if (applications.length > 0) {
                if (q.offset > 0) {
                    minName = applications[0].metadata.name;
                }
                if (applicationsList.stats.total > q.offset + applications.length) {
                    maxName = applications[applications.length - 1].metadata.name;
                }
            }

            return combineLatest([
                merge(
                    from([applicationsList.stats]),
                    reloadStats
                        .pipe(bufferTime(2000))
                        .pipe(filter(items => items.length > 0))
                        .pipe(mergeMap(() => services.applications.list(objectListKind, {...q, limit: 0, fields: ['stats']})))
                        .pipe(map(({stats}) => stats))
                ),
                merge(
                    from([applications]),
                    services.applications
                        .watch(objectListKind, {...q, minName, maxName, fields: watchFields})
                        .pipe(repeat())
                        .pipe(retryWhen(errors => errors.pipe(delay(WATCH_RETRY_TIMEOUT))))
                        // batch events to avoid constant re-rendering and improve UI performance
                        .pipe(bufferTime(EVENTS_BUFFER_TIMEOUT))
                        .pipe(
                            map(appChanges => {
                                appChanges.forEach(appChange => {
                                    const index = applications.findIndex(item => AppUtils.appInstanceName(item) === AppUtils.appInstanceName(appChange.application));
                                    switch (appChange.type) {
                                        case 'DELETED':
                                            if (index > -1) {
                                                applications.splice(index, 1);
                                            }
                                            break;
                                        default:
                                            if (index > -1) {
                                                applications[index] = appChange.application;
                                            } else {
                                                applications.unshift(appChange.application);
                                            }
                                            break;
                                    }
                                    reloadStats.next(new Date());
                                });
                                return {applications, updated: appChanges.length > 0};
                            })
                        )
                        .pipe(filter(item => item.updated))
                        .pipe(map(item => item.applications))
                )
            ]).pipe(map(([stats, applications]) => ({applications, stats})));
        })
    );
}

const ViewPref = ({
    children
}: {
    children: (data: {pref: AppsListPreferences & {page: number; pageSize: number; search: string}; healthBarPrefs: HealthStatusBarPreferences}) => React.ReactNode;
}) => {
    const observableQuery$ = useObservableQuery();

    return (
        <DataLoader
            load={() =>
                combineLatest([
                    services.viewPreferences.getPreferences().pipe(map(item => ({...item.appList, pageSize: item.pageSizes['applications-list'] || 5}))),
                    observableQuery$
                ]).pipe(
                    map(items => {
                        const params = items[1];
                        const viewPref: AppsListPreferences = {...items[0]};
                        if (params.get('proj') != null) {
                            viewPref.projectsFilter = params
                                .get('proj')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('sync') != null) {
                            viewPref.syncFilter = params
                                .get('sync')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('autoSync') != null) {
                            viewPref.autoSyncFilter = params
                                .get('autoSync')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('operation') != null) {
                            viewPref.operationFilter = params
                                .get('operation')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('health') != null) {
                            viewPref.healthFilter = params
                                .get('health')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('namespace') != null) {
                            viewPref.namespacesFilter = params
                                .get('namespace')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('targetRevision') != null) {
                            viewPref.targetRevisionFilter = params
                                .get('targetRevision')
                                .split(',')
                                .map(decodeURIComponent)
                                .filter(item => !!item);
                        }
                        if (params.get('cluster') != null) {
                            viewPref.clustersFilter = params
                                .get('cluster')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('showFavorites') != null) {
                            viewPref.showFavorites = params.get('showFavorites') === 'true';
                        }
                        if (params.get('view') != null) {
                            viewPref.view = params.get('view') as AppsListViewType;
                        }
                        if (params.get('labels') != null) {
                            viewPref.labelsFilter = params
                                .get('labels')
                                .split(',')
                                .map(decodeURIComponent)
                                .filter(item => !!item);
                        }
                        if (params.get('annotations') != null) {
                            viewPref.annotationsFilter = params
                                .get('annotations')
                                .split(',')
                                .map(decodeURIComponent)
                                .filter(item => !!item);
                        }
                        if (params.get('repo') != null) {
                            viewPref.reposFilter = params
                                .get('repo')
                                .split(',')
                                .map(decodeURIComponent)
                                .filter(item => !!item);
                        }
                        return {
                            ...viewPref,
                            page: parseInt(params.get('page') || '0', 10),
                            pageSize: items[0].pageSize,
                            search: params.get('search') || ''
                        };
                    })
                )
            }>
            {pref => children({pref, healthBarPrefs: pref.statusBarView || ({} as HealthStatusBarPreferences)})}
        </DataLoader>
    );
};

function filterApplicationSets(
    appSets: models.ApplicationSet[],
    pref: AppSetsListPreferences,
    search: string
): {filteredApps: models.ApplicationSet[]; filterResults: ApplicationSetFilteredApp[]} {
    const filterResults = getAppSetFilterResults(appSets, pref);

    return {
        filterResults,
        filteredApps: filterResults.filter(
            app => (search === '' || app.metadata.name.includes(search) || app.metadata.namespace.includes(search)) && Object.values(app.filterResult).every(val => val)
        )
    };
}

function tryJsonParse(input: string) {
    try {
        return (input && JSON.parse(input)) || null;
    } catch {
        return null;
    }
}

const SearchBar = (props: {content: string; objectListKind: string; ctx: ContextApis}) => {
    const {content, ctx} = {...props};

    const searchBar = React.useRef<HTMLDivElement>(null);

    const query = new URLSearchParams(window.location.search);
    const appInput = tryJsonParse(query.get('new'));

    const {useKeybinding} = React.useContext(KeybindingContext);
    const [isFocused, setFocus] = React.useState(false);
    const useAuthSettingsCtx = React.useContext(AuthSettingsCtx);
    const [value, setValue] = React.useState(props.content);

    React.useEffect(() => {
        const to = setTimeout(() => {
            ctx.navigation.goto('.', {search: value}, {replace: true});
        }, 500);
        return () => clearInterval(to);
    }, [value]);

    useKeybinding({
        keys: Key.SLASH,
        action: () => {
            if (searchBar.current && !appInput) {
                searchBar.current.querySelector('input').focus();
                setFocus(true);
                return true;
            }
            return false;
        }
    });

    useKeybinding({
        keys: Key.ESCAPE,
        action: () => {
            if (searchBar.current && !appInput && isFocused) {
                searchBar.current.querySelector('input').blur();
                setFocus(false);
                return true;
            }
            return false;
        }
    });

    return (
        <DataLoader
            input={value}
            noLoaderOnInputChange={true}
            load={() =>
                services.applications.list(props.objectListKind, {fields: ['items.metadata.name', 'items.metadata.namespace'], search: value, limit: 100}).then(res => res.items)
            }>
            {apps => (
                <Autocomplete
                    filterSuggestions={true}
                    renderInput={inputProps => (
                        <div className='applications-list__search' ref={searchBar}>
                            <i
                                className='fa fa-search'
                                style={{marginRight: '9px', cursor: 'pointer'}}
                                onClick={() => {
                                    if (searchBar.current) {
                                        searchBar.current.querySelector('input').focus();
                                    }
                                }}
                            />
                            <input
                                {...inputProps}
                                onFocus={e => {
                                    e.target.select();
                                    if (inputProps.onFocus) {
                                        inputProps.onFocus(e);
                                    }
                                }}
                                style={{fontSize: '14px'}}
                                className='argo-field'
                                placeholder='Search applications...'
                            />
                            <div className='keyboard-hint'>/</div>
                            {content && <i className='fa fa-times' onClick={() => setValue(null)} style={{cursor: 'pointer', marginLeft: '5px'}} />}
                        </div>
                    )}
                    wrapperProps={{className: 'applications-list__search-wrapper'}}
                    renderItem={item => (
                        <React.Fragment>
                            <i className='icon argo-icon-application' /> {item.label}
                        </React.Fragment>
                    )}
                    onSelect={val => {
                        const selectedApp = apps?.find(app => {
                            const qualifiedName = AppUtils.appQualifiedName(app, useAuthSettingsCtx?.appsInAnyNamespaceEnabled);
                            return qualifiedName === val;
                        });
                        if (selectedApp) {
                            ctx.navigation.goto(`/${AppUtils.getAppUrl(selectedApp)}`);
                        }
                    }}
                    onChange={e => setValue(e.target.value)}
                    value={value || ''}
                    items={apps.map(app => AppUtils.appQualifiedName(app, useAuthSettingsCtx?.appsInAnyNamespaceEnabled))}
                />
            )}
        </DataLoader>
    );
};

interface ApplicationsToolbarProps {
    pref: AppsListPreferences & {page: number; search: string};
    ctx: ContextApis;
    healthBarPrefs: HealthStatusBarPreferences;
    objectListKind: string;
}

const ApplicationsToolbar: React.FC<ApplicationsToolbarProps> = ({pref, ctx, healthBarPrefs, objectListKind}) => {
    const {List, Summary, Tiles} = AppsListViewKey;
    const query = useQuery();

    return (
        <React.Fragment key='app-list-tools'>
            <SearchBar objectListKind={objectListKind} content={query.get('search')} ctx={ctx} />
            <Tooltip content='Toggle Health Status Bar'>
                <button
                    className={`applications-list__accordion argo-button argo-button--base${healthBarPrefs.showHealthStatusBar ? '-o' : ''}`}
                    style={{border: 'none'}}
                    onClick={() => {
                        healthBarPrefs.showHealthStatusBar = !healthBarPrefs.showHealthStatusBar;
                        services.viewPreferences.updatePreferences({
                            appList: {
                                ...pref,
                                statusBarView: {
                                    ...healthBarPrefs,
                                    showHealthStatusBar: healthBarPrefs.showHealthStatusBar
                                }
                            }
                        });
                    }}>
                    <i className={`fas fa-ruler-horizontal`} />
                </button>
            </Tooltip>
            <div className='applications-list__view-type' style={{marginLeft: 'auto'}}>
                <i
                    className={classNames('fa fa-th', {selected: pref.view === Tiles}, 'menu_icon')}
                    title='Tiles'
                    onClick={() => {
                        ctx.navigation.goto('.', {view: Tiles});
                        preserveFavoritesAndSwitchView(pref, Tiles);
                    }}
                />
                <i
                    className={classNames('fa fa-th-list', {selected: pref.view === List}, 'menu_icon')}
                    title='List'
                    onClick={() => {
                        ctx.navigation.goto('.', {view: List});
                        preserveFavoritesAndSwitchView(pref, List);
                    }}
                />
                <i
                    className={classNames('fa fa-chart-pie', {selected: pref.view === Summary}, 'menu_icon')}
                    title='Summary'
                    onClick={() => {
                        ctx.navigation.goto('.', {view: Summary});
                        preserveFavoritesAndSwitchView(pref, Summary);
                    }}
                />
            </div>
        </React.Fragment>
    );
};

const prefsToQuery = (prefs: AppsListPreferences & {page: number; pageSize: number}, search: string): AppsQuery => {
    const query: AppsQuery = {search, offset: prefs.page * prefs.pageSize, limit: prefs.pageSize};
    if (prefs.projectsFilter) {
        query.projects = prefs.projectsFilter;
    }
    if (prefs.labelsFilter) {
        query.selector = prefs.labelsFilter.join(',');
    }
    if (prefs.healthFilter) {
        query.healthStatuses = prefs.healthFilter;
    }
    if (prefs.syncFilter) {
        query.syncStatuses = prefs.syncFilter;
    }
    if (prefs.namespacesFilter) {
        query.namespaces = prefs.namespacesFilter;
    }
    if (prefs.clustersFilter) {
        query.clusters = prefs.clustersFilter;
    }
    if (prefs.operationFilter) {
        query.operationPhases = prefs.operationFilter;
    }
    if (prefs.autoSyncFilter?.length > 0) {
        query.autoSyncEnabled = prefs.autoSyncFilter.findIndex(item => item === 'Enabled') > -1;
    }
    if (prefs.showFavorites) {
        const favorites = Array.from(new Set((prefs.favoritesAppUids || []).filter(uid => !!uid && typeof uid === 'string')));
        if (favorites.length > 0) {
            query.uids = favorites;
        }
    }
    if (prefs.annotationsFilter.length) {
        query.annotationsSelector = prefs.annotationsFilter[0];
    }
    if (prefs.targetRevisionFilter.length) {
        query.revisions = prefs.targetRevisionFilter;
    }
    if (prefs.reposFilter?.length) {
        query.repos = prefs.reposFilter;
    }

    return query;
};

function isFiltered(prefs: AppsListPreferences): boolean {
    return (
        !!prefs.projectsFilter ||
        !!prefs.labelsFilter ||
        !!prefs.healthFilter ||
        !!prefs.syncFilter ||
        !!prefs.namespacesFilter ||
        !!prefs.clustersFilter ||
        !!prefs.autoSyncFilter ||
        !!prefs.reposFilter?.length
    );
}

export const ApplicationsList = (props: RouteComponentProps<any> & {objectListKind: string}) => {
    const query = useQuery();
    const observableQuery$ = useObservableQuery();
    const appInput = tryJsonParse(query.get('new'));
    const syncAppsInput = tryJsonParse(query.get('syncApps'));
    const refreshAppsInput = tryJsonParse(query.get('refreshApps'));
    const [createApi, setCreateApi] = React.useState(null);
    const clusters = React.useMemo(() => services.clusters.list(), []);
    const [isAppCreatePending, setAppCreatePending] = React.useState(false);
    const loaderRef = React.useRef<DataLoader | null>(null);
    const {List, Summary, Tiles} = AppsListViewKey;

    const objectListKind = props.objectListKind;
    const isListOfApplications = objectListKind === 'application';

    function refreshApp(appName: string, appNamespace: string) {
        // app refreshing might be done too quickly so that UI might miss it due to event batching
        // add refreshing annotation in the UI to improve user experience
        if (loaderRef.current) {
            const data = loaderRef.current.getData() as {applications: models.Application[]; stats: models.ApplicationListStats};
            const applications = data.applications.slice();
            const app = applications.find(item => item.metadata.name === appName && item.metadata.namespace === appNamespace);
            if (app) {
                AppUtils.setAppRefreshing(app);
                loaderRef.current.setData({...data, applications});
            }
        }
        services.applications.get(appName, appNamespace, objectListKind, 'normal');
    }

    function onFilterPrefChanged(ctx: ContextApis, prevPref: AppsListPreferences, newPref: AppsListPreferences) {
        services.viewPreferences.updatePreferences({appList: newPref});
        const navParams: any = {
            proj: newPref.projectsFilter.join(','),
            sync: newPref.syncFilter.join(','),
            autoSync: newPref.autoSyncFilter.join(','),
            health: newPref.healthFilter.join(','),
            namespace: newPref.namespacesFilter.join(','),
            targetRevision: newPref.targetRevisionFilter.map(encodeURIComponent).join(','),
            repo: newPref.reposFilter.map(encodeURIComponent).join(','),
            cluster: newPref.clustersFilter.join(','),
            labels: newPref.labelsFilter.map(encodeURIComponent).join(','),
            operation: newPref.operationFilter.join(','),
            annotations: newPref.annotationsFilter.map(encodeURIComponent).join(',')
        };
        navParams.showFavorites = newPref.showFavorites ? 'true' : null;
        // Only force-reset page to 0 when Favorites is toggled ON (false -> true).
        if (newPref.showFavorites && !prevPref.showFavorites) {
            navParams.page = 0;
        }
        ctx.navigation.goto('.', navParams, {replace: true});
    }

    function onAppSetFilterPrefChanged(ctx: ContextApis, newPref: AppSetsListPreferences) {
        // Use appList since ViewPreferences shares preferences between apps and appsets
        services.viewPreferences.updatePreferences({appList: newPref as AppsListPreferences});
        ctx.navigation.goto(
            '.',
            {
                health: newPref.healthFilter.join(','),
                labels: newPref.labelsFilter.map(encodeURIComponent).join(','),
                // Keep URL and preferences consistent. When false, remove the param entirely.
                showFavorites: newPref.showFavorites ? 'true' : null
            },
            {replace: true}
        );
    }

    function getPageTitle(view: string) {
        const entityName = isListOfApplications ? 'Applications' : 'ApplicationSets';
        switch (view) {
            case List:
                return `${entityName} List`;
            case Tiles:
                return `${entityName} Tiles`;
            case Summary:
                return `${entityName} Summary`;
        }
        return '';
    }

    const sidebarTarget = useSidebarTarget();

    return (
        <ClusterCtx.Provider value={clusters}>
            <KeybindingProvider>
                <Consumer>
                    {ctx => (
                        <ViewPref>
                            {({pref, healthBarPrefs}) => (
                                <Page
                                    key={pref.view}
                                    title={getPageTitle(pref.view)}
                                    useTitleOnly={true}
                                    toolbar={{
                                        breadcrumbs: [
                                            {
                                                title: isListOfApplications ? 'Applications' : 'ApplicationSets',
                                                path: isListOfApplications ? '/applications' : '/applicationsets'
                                            }
                                        ]
                                    }}
                                    hideAuth={true}>
                                    <FlexTopBar
                                        toolbar={{
                                            tools: <ApplicationsToolbar objectListKind={objectListKind} pref={pref} ctx={ctx} healthBarPrefs={healthBarPrefs} />,
                                            actionMenu: {
                                                items: [
                                                    {
                                                        title: 'New App',
                                                        iconClassName: 'fa fa-plus',
                                                        qeId: 'applications-list-button-new-app',
                                                        action: () => ctx.navigation.goto('.', {new: '{}'}, {replace: true})
                                                    },
                                                    {
                                                        title: 'Sync Apps',
                                                        iconClassName: 'fa fa-sync',
                                                        action: () => ctx.navigation.goto('.', {syncApps: true}, {replace: true})
                                                    },
                                                    {
                                                        title: 'Refresh Apps',
                                                        iconClassName: 'fa fa-redo',
                                                        action: () => ctx.navigation.goto('.', {refreshApps: true}, {replace: true})
                                                    }
                                                ]
                                            }
                                        }}
                                    />
                                    <DataLoader
                                        input={JSON.stringify({...prefsToQuery(pref, query.get('search'))})}
                                        ref={loaderRef}
                                        load={() =>
                                            AppUtils.handlePageVisibility(() =>
                                                loadApplications({...prefsToQuery(pref, query.get('search')), appNamespace: query.get('appNamespace')}, objectListKind)
                                            )
                                        }
                                        loadingRenderer={() => (
                                            <div className='argo-container'>
                                                <MockupList height={100} marginTop={30} />
                                            </div>
                                        )}>
                                        {({applications, stats}: {applications: models.Application[]; stats: models.ApplicationListStats}) => {
                                            const healthBarPrefs = pref.statusBarView || ({} as HealthStatusBarPreferences);
                                            const handleCreatePanelClose = async () => {
                                                const outsideDiv = document.querySelector('.sliding-panel__outside');
                                                const closeButton = document.querySelector('.sliding-panel__close');

                                                if (outsideDiv && closeButton && closeButton !== document.activeElement) {
                                                    const confirmed = await ctx.popup.confirm('Close Panel', 'Closing this panel will discard all entered values. Continue?');
                                                    if (confirmed) {
                                                        ctx.navigation.goto('.', {new: null}, {replace: true});
                                                    }
                                                } else if (closeButton === document.activeElement) {
                                                    // If the close button is focused or clicked, close without confirmation
                                                    ctx.navigation.goto('.', {new: null}, {replace: true});
                                                }
                                            };

                                            if (isListOfApplications) {
                                                const noFavoritesSelected = pref.showFavorites && (pref.favoritesAppUids || []).length === 0;
                                                const visibleApps = noFavoritesSelected ? [] : applications;
                                                const totalForPaginate = noFavoritesSelected ? 0 : stats.total;
                                                const headerNode = !noFavoritesSelected && stats.total > 1 ? <ApplicationsStatusBar stats={stats} /> : undefined;
                                                return (
                                                    <React.Fragment>
                                                        <div className='applications-list'>
                                                            {stats.total === 0 && !isFiltered(pref) ? (
                                                                <EmptyState icon='argo-icon-application'>
                                                                    <h4>No applications available to you just yet</h4>
                                                                    <h5>Create new application to start managing resources in your cluster</h5>
                                                                    <button
                                                                        qe-id='applications-list-button-create-application'
                                                                        className='argo-button argo-button--base'
                                                                        onClick={() => ctx.navigation.goto('.', {new: JSON.stringify({})}, {replace: true})}>
                                                                        Create application
                                                                    </button>
                                                                </EmptyState>
                                                            ) : (
                                                                <>
                                                                    {ReactDOM.createPortal(
                                                                        <DataLoader load={() => services.viewPreferences.getPreferences()}>
                                                                            {allpref => (
                                                                                <ApplicationsFilter
                                                                                    stats={stats}
                                                                                    onChange={newPrefs => onFilterPrefChanged(ctx, pref, newPrefs)}
                                                                                    pref={pref}
                                                                                    collapsed={allpref.hideSidebar}
                                                                                />
                                                                            )}
                                                                        </DataLoader>,
                                                                        sidebarTarget?.current
                                                                    )}

                                                                    {(pref.view === 'summary' && <ApplicationsSummary stats={stats} />) || (
                                                                        <Paginate
                                                                            header={headerNode}
                                                                            total={totalForPaginate}
                                                                            showHeader={healthBarPrefs.showHealthStatusBar}
                                                                            preferencesKey='applications-list'
                                                                            page={pref.page}
                                                                            emptyState={() => (
                                                                                <EmptyState icon='fa fa-search'>
                                                                                    <h4>No matching applications found</h4>
                                                                                    <h5>
                                                                                        Change filter criteria or&nbsp;
                                                                                        <a
                                                                                            onClick={() => {
                                                                                                const prev = {...pref};
                                                                                                AppsListPreferences.clearFilters(pref);
                                                                                                onFilterPrefChanged(ctx, prev, pref);
                                                                                            }}>
                                                                                            clear filters
                                                                                        </a>
                                                                                    </h5>
                                                                                </EmptyState>
                                                                            )}
                                                                            sortOptions={[
                                                                                {
                                                                                    title: 'Name',
                                                                                    compare: (a, b) => a.metadata.name.localeCompare(b.metadata.name, undefined, {numeric: true})
                                                                                },
                                                                                {
                                                                                    title: 'Created At',
                                                                                    compare: (b, a) => a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp)
                                                                                },
                                                                                {
                                                                                    title: 'Synchronized',
                                                                                    compare: (b, a) =>
                                                                                        a.status.operationState?.finishedAt?.localeCompare(b.status.operationState?.finishedAt)
                                                                                }
                                                                            ]}
                                                                            data={visibleApps}
                                                                            onPageChange={page =>
                                                                                ctx.navigation.goto('.', {
                                                                                    page,
                                                                                    // Preserve showFavorites in URL during pagination
                                                                                    showFavorites: pref.showFavorites ? 'true' : null
                                                                                })
                                                                            }>
                                                                            {data =>
                                                                                (pref.view === 'tiles' && (
                                                                                    <ApplicationTiles
                                                                                        applications={data}
                                                                                        syncApplication={(appName, appNamespace) =>
                                                                                            ctx.navigation.goto('.', {syncApp: appName, appNamespace}, {replace: true})
                                                                                        }
                                                                                        refreshApplication={refreshApp}
                                                                                        deleteApplication={(appName, appNamespace) =>
                                                                                            AppUtils.deleteApplication(appName, appNamespace, ctx)
                                                                                        }
                                                                                    />
                                                                                )) || (
                                                                                    <ApplicationsTable
                                                                                        applications={data}
                                                                                        syncApplication={(appName, appNamespace) =>
                                                                                            ctx.navigation.goto('.', {syncApp: appName, appNamespace}, {replace: true})
                                                                                        }
                                                                                        refreshApplication={refreshApp}
                                                                                        deleteApplication={(appName, appNamespace) =>
                                                                                            AppUtils.deleteApplication(appName, appNamespace, ctx)
                                                                                        }
                                                                                    />
                                                                                )
                                                                            }
                                                                        </Paginate>
                                                                    )}
                                                                </>
                                                            )}
                                                            <ApplicationsSyncPanel
                                                                key='syncsPanel'
                                                                show={syncAppsInput}
                                                                hide={() => ctx.navigation.goto('.', {syncApps: null}, {replace: true})}
                                                                apps={applications}
                                                            />
                                                            <ApplicationsRefreshPanel
                                                                key='refreshPanel'
                                                                show={refreshAppsInput}
                                                                hide={() => ctx.navigation.goto('.', {refreshApps: null}, {replace: true})}
                                                                apps={applications}
                                                            />
                                                        </div>
                                                        <DataLoader
                                                            load={() =>
                                                                observableQuery$.pipe(
                                                                    mergeMap(params => {
                                                                        const syncApp = params.get('syncApp');
                                                                        const appNamespace = params.get('appNamespace');
                                                                        return (syncApp && from(services.applications.get(syncApp, appNamespace, objectListKind))) || from([null]);
                                                                    })
                                                                )
                                                            }>
                                                            {app => (
                                                                <ApplicationSyncPanel
                                                                    key='syncPanel'
                                                                    application={app}
                                                                    selectedResource={'all'}
                                                                    hide={() => ctx.navigation.goto('.', {syncApp: null}, {replace: true})}
                                                                />
                                                            )}
                                                        </DataLoader>
                                                        <SlidingPanel
                                                            isShown={!!appInput}
                                                            onClose={() => handleCreatePanelClose()} //Separate handling for outside click.
                                                            header={
                                                                <div>
                                                                    <button
                                                                        qe-id='applications-list-button-create'
                                                                        className='argo-button argo-button--base'
                                                                        disabled={isAppCreatePending}
                                                                        onClick={() => createApi && createApi.submitForm(null)}>
                                                                        <Spinner show={isAppCreatePending} style={{marginRight: '5px'}} />
                                                                        Create
                                                                    </button>{' '}
                                                                    <button
                                                                        qe-id='applications-list-button-cancel'
                                                                        onClick={() => ctx.navigation.goto('.', {new: null}, {replace: true})}
                                                                        className='argo-button argo-button--base-o'>
                                                                        Cancel
                                                                    </button>
                                                                </div>
                                                            }>
                                                            {appInput && (
                                                                <ApplicationCreatePanel
                                                                    getFormApi={api => {
                                                                        setCreateApi(api);
                                                                    }}
                                                                    createApp={async app => {
                                                                        setAppCreatePending(true);
                                                                        try {
                                                                            await services.applications.create(app);
                                                                            ctx.navigation.goto('.', {new: null}, {replace: true});
                                                                        } catch (e) {
                                                                            ctx.notifications.show({
                                                                                content: <ErrorNotification title='Unable to create application' e={e} />,
                                                                                type: NotificationType.Error
                                                                            });
                                                                        } finally {
                                                                            setAppCreatePending(false);
                                                                        }
                                                                    }}
                                                                    app={appInput}
                                                                    onAppChanged={app => ctx.navigation.goto('.', {new: JSON.stringify(app)}, {replace: true})}
                                                                />
                                                            )}
                                                        </SlidingPanel>
                                                    </React.Fragment>
                                                );
                                            } else {
                                                // ApplicationSets path - fully type-safe
                                                // @ts-expect-error it is appsets
                                                const appSets = applications as models.ApplicationSet[];
                                                const appSetPref: AppSetsListPreferences = {
                                                    labelsFilter: pref.labelsFilter,
                                                    healthFilter: pref.healthFilter,
                                                    showFavorites: pref.showFavorites,
                                                    favoritesAppUids: pref.favoritesAppUids,
                                                    view: pref.view,
                                                    hideFilters: pref.hideFilters,
                                                    statusBarView: pref.statusBarView,
                                                    annotationsFilter: pref.annotationsFilter
                                                };
                                                const {filteredApps, filterResults} = filterApplicationSets(appSets, appSetPref, pref.search);

                                                return (
                                                    <React.Fragment>
                                                        <FlexTopBar
                                                            toolbar={{
                                                                tools: (
                                                                    <ApplicationsToolbar pref={pref} ctx={ctx} healthBarPrefs={healthBarPrefs} objectListKind={objectListKind} />
                                                                ),
                                                                actionMenu: {
                                                                    items: [] // No action menu for ApplicationSets yet
                                                                }
                                                            }}
                                                        />
                                                        <div className='applications-list'>
                                                            {appSets.length === 0 && (pref.labelsFilter || []).length === 0 ? (
                                                                <EmptyState icon='argo-icon-application'>
                                                                    <h4>No ApplicationSets available to you just yet</h4>
                                                                    <h5>ApplicationSets will appear here once created</h5>
                                                                </EmptyState>
                                                            ) : (
                                                                <>
                                                                    {ReactDOM.createPortal(
                                                                        <DataLoader load={() => services.viewPreferences.getPreferences()}>
                                                                            {allpref => (
                                                                                <AppSetsFilter
                                                                                    apps={filterResults}
                                                                                    onChange={newPrefs => onAppSetFilterPrefChanged(ctx, newPrefs)}
                                                                                    pref={appSetPref}
                                                                                    collapsed={allpref.hideSidebar}
                                                                                />
                                                                            )}
                                                                        </DataLoader>,
                                                                        sidebarTarget?.current
                                                                    )}

                                                                    <Paginate
                                                                        header={filteredApps.length > 1 && <AppSetsStatusBar appSets={filteredApps} />}
                                                                        showHeader={healthBarPrefs.showHealthStatusBar}
                                                                        preferencesKey='applications-list'
                                                                        page={pref.page}
                                                                        defaultPageSize={5}
                                                                        emptyState={() => (
                                                                            <EmptyState icon='fa fa-search'>
                                                                                <h4>No matching application sets found</h4>
                                                                                <h5>
                                                                                    Change filter criteria or&nbsp;
                                                                                    <a
                                                                                        onClick={() => {
                                                                                            AppSetsListPreferences.clearFilters(appSetPref);
                                                                                            onAppSetFilterPrefChanged(ctx, appSetPref);
                                                                                        }}>
                                                                                        clear filters
                                                                                    </a>
                                                                                </h5>
                                                                            </EmptyState>
                                                                        )}
                                                                        sortOptions={[
                                                                            {
                                                                                title: 'Name',
                                                                                compare: (a, b) => a.metadata.name.localeCompare(b.metadata.name, undefined, {numeric: true})
                                                                            },
                                                                            {
                                                                                title: 'Created At',
                                                                                compare: (b, a) => a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp)
                                                                            }
                                                                        ]}
                                                                        data={filteredApps}
                                                                        onPageChange={page =>
                                                                            ctx.navigation.goto('.', {
                                                                                page,
                                                                                // Preserve showFavorites in URL during pagination
                                                                                showFavorites: pref.showFavorites ? 'true' : null
                                                                            })
                                                                        }>
                                                                        {data =>
                                                                            (pref.view === 'tiles' && (
                                                                                <ApplicationTiles
                                                                                    applications={data}
                                                                                    syncApplication={() => {}}
                                                                                    refreshApplication={() => {}}
                                                                                    deleteApplication={() => {}}
                                                                                />
                                                                            )) || (
                                                                                <ApplicationsTable
                                                                                    applications={data}
                                                                                    syncApplication={() => {}}
                                                                                    refreshApplication={() => {}}
                                                                                    deleteApplication={() => {}}
                                                                                />
                                                                            )
                                                                        }
                                                                    </Paginate>
                                                                </>
                                                            )}
                                                        </div>
                                                    </React.Fragment>
                                                );
                                            }
                                        }}
                                    </DataLoader>
                                </Page>
                            )}
                        </ViewPref>
                    )}
                </Consumer>
            </KeybindingProvider>
        </ClusterCtx.Provider>
    );
};
