import {useData, Checkbox} from 'argo-ui/v2';
import * as React from 'react';
import {
    ApplicationDestination,
    ApplicationSet,
    Cluster,
    HealthStatusCode,
    HealthStatuses,
    OperationStateTitles,
    SyncStatusCode,
    ApplicationListStats,
    SyncStatuses
} from '../../../shared/models';
import {AppsListPreferences, AppSetsListPreferences, services} from '../../../shared/services';
import {Filter, FiltersGroup} from '../filter/filter';
import {createMetadataSelector} from '../selectors';
import {ComparisonStatusIcon, getAppSetHealthStatus, HealthStatusIcon} from '../utils';
import {formatClusterQueryParam} from '../../../shared/utils';
import {COLORS} from '../../../shared/components';

export interface FilterResult {
    sync: boolean;
    autosync: boolean;
    health: boolean;
    clusters: boolean;
    namespaces: boolean;
    targetRevision: boolean;
    operation: boolean;
    annotations: boolean;
    favourite: boolean;
    labels: boolean;
}

export interface ApplicationSetFilterResult {
    health: boolean;
    favourite: boolean;
    labels: boolean;
}

export interface ApplicationSetFilteredApp extends ApplicationSet {
    filterResult: ApplicationSetFilterResult;
}

export function getAppSetFilterResults(appSets: ApplicationSet[], pref: AppSetsListPreferences): ApplicationSetFilteredApp[] {
    const labelSelector = createMetadataSelector(pref.labelsFilter || []);

    return appSets.map(appSet => ({
        ...appSet,
        filterResult: {
            health: pref.healthFilter.length === 0 || pref.healthFilter.includes(getAppSetHealthStatus(appSet)),
            favourite: !pref.showFavorites || (pref.favoritesAppList && pref.favoritesAppList.includes(appSet.metadata.name)),
            labels: pref.labelsFilter.length === 0 || labelSelector(appSet.metadata.labels)
        }
    }));
}

const optionsFrom = (options: string[], filter: string[]) => {
    return options
        .filter(s => filter.indexOf(s) === -1)
        .sort((a, b) => a.localeCompare(b))
        .map(item => {
            return {label: item};
        });
};

interface AppFilterProps {
    stats: ApplicationListStats;
    pref: AppsListPreferences;
    onChange: (newPrefs: AppsListPreferences) => void;
    children?: React.ReactNode;
    collapsed?: boolean;
}

// Props for ApplicationSet filters
export interface AppSetFilterProps {
    apps: ApplicationSetFilteredApp[];
    pref: AppSetsListPreferences;
    onChange: (newPrefs: AppSetsListPreferences) => void;
    children?: React.ReactNode;
    collapsed?: boolean;
}

const getAppSetCounts = (apps: ApplicationSetFilteredApp[], filterType: keyof ApplicationSetFilterResult, filter: (app: ApplicationSet) => string, init?: string[]) => {
    const map = new Map<string, number>();
    if (init) {
        init.forEach(key => map.set(key, 0));
    }
    // filter out all apps that does not match other filters and ignore this filter result
    apps.filter(app => filter(app) && Object.keys(app.filterResult).every((key: keyof ApplicationSetFilterResult) => key === filterType || app.filterResult[key])).forEach(app =>
        map.set(filter(app), (map.get(filter(app)) || 0) + 1)
    );
    return map;
};

const getOptions = (counts: {[key: string]: number}, keys: string[], getIcon?: (k: string) => React.ReactNode) => {
    return keys.map(k => {
        return {
            label: k,
            icon: getIcon && getIcon(k),
            count: counts && counts[k]
        };
    });
};

const getAppSetOptions = (
    apps: ApplicationSetFilteredApp[],
    filterType: keyof ApplicationSetFilterResult,
    filter: (app: ApplicationSet) => string,
    keys: string[],
    getIcon?: (k: string) => React.ReactNode
) => {
    const counts = getAppSetCounts(apps, filterType, filter, keys);
    return keys.map(k => {
        return {
            label: k,
            icon: getIcon && getIcon(k),
            count: counts.get(k)
        };
    });
};

const SyncFilter = (props: AppFilterProps) => (
    <Filter
        label='SYNC STATUS'
        selected={props.pref.syncFilter}
        setSelected={s => props.onChange({...props.pref, syncFilter: s})}
        options={getOptions(props.stats.totalBySyncStatus, Object.keys(SyncStatuses), s => (
            <ComparisonStatusIcon status={s as SyncStatusCode} noSpin={true} />
        ))}
    />
);

const AppHealthFilter = (props: AppFilterProps) => (
    <Filter
        label='HEALTH STATUS'
        selected={props.pref.healthFilter}
        setSelected={s => props.onChange({...props.pref, healthFilter: s})}
        options={getOptions(props.stats.totalByHealthStatus, Object.keys(HealthStatuses), s => (
            <HealthStatusIcon state={{status: s as HealthStatusCode, message: ''}} noSpin={true} />
        ))}
    />
);

const AppSetHealthFilter = (props: AppSetFilterProps) => (
    <Filter
        label='HEALTH STATUS'
        selected={props.pref.healthFilter}
        setSelected={s => props.onChange({...props.pref, healthFilter: s})}
        options={getAppSetOptions(
            props.apps,
            'health',
            app => getAppSetHealthStatus(app),
            ['Healthy', 'Progressing', 'Degraded', 'Unknown'],
            s => (
                <HealthStatusIcon state={{status: s as HealthStatusCode, message: ''}} noSpin={true} />
            )
        )}
    />
);

const AppsetLabelsFilter = React.memo(
    (props: {apps: Array<{metadata: {labels?: {[key: string]: string}}}>; pref: {labelsFilter: string[]}; onChange: (labelsFilter: string[]) => void}) => {
        const labelOptions = React.useMemo(() => {
            const labels = new Map<string, Set<string>>();
            props.apps
                .filter(app => app.metadata && app.metadata.labels)
                .forEach(app =>
                    Object.keys(app.metadata.labels).forEach(label => {
                        let values = labels.get(label);
                        if (!values) {
                            values = new Set<string>();
                            labels.set(label, values);
                        }
                        values.add(app.metadata.labels[label]);
                    })
                );
            const suggestions: string[] = [];
            labels.forEach((values, label) => {
                suggestions.push(label);
                values.forEach(val => suggestions.push(`${label}=${val}`));
            });
            return suggestions.map(s => ({label: s}));
        }, [props.apps]);

        return <Filter label='LABELS' selected={props.pref.labelsFilter} setSelected={s => props.onChange(s)} field={true} options={labelOptions} />;
    }
);

const LabelsFilter = (props: AppFilterProps) => {
    const suggestions = new Array<string>();
    (props.stats.labels || []).forEach(labelStats => {
        suggestions.push(labelStats.key);
        labelStats.values.forEach(val => suggestions.push(`${labelStats.key}=${val}`));
    });
    const labelOptions = suggestions
        .sort((a, b) => a.localeCompare(b))
        .map(s => {
            return {label: s};
        });

    return <Filter label='LABELS' selected={props.pref.labelsFilter} setSelected={s => props.onChange({...props.pref, labelsFilter: s})} field={true} options={labelOptions} />;
};

const AnnotationsFilter = (props: AppFilterProps) => {
    const suggestions = new Array<string>();
    (props.stats.annotations || []).forEach(annotationStats => {
        suggestions.push(annotationStats.key);
        annotationStats.values.forEach(val => suggestions.push(`${annotationStats.key}=${val}`));
    });
    const annotationOptions = suggestions
        .sort((a, b) => a.localeCompare(b))
        .map(s => {
            return {label: s};
        });

    return (
        <Filter
            label='ANNOTATIONS'
            selected={props.pref.annotationsFilter}
            setSelected={s => props.onChange({...props.pref, annotationsFilter: s})}
            field={true}
            options={annotationOptions}
        />
    );
};

const ProjectFilter = (props: AppFilterProps) => {
    const [projects, loading, error] = useData(
        () => services.projects.list('items.metadata.name'),
        null,
        () => null
    );
    const projectOptions = (projects || []).map(proj => {
        return {label: proj.metadata.name};
    });
    return (
        <Filter
            label='PROJECTS'
            selected={props.pref.projectsFilter}
            setSelected={s => props.onChange({...props.pref, projectsFilter: s})}
            field={true}
            options={projectOptions}
            error={error.state}
            retry={error.retry}
            loading={loading}
        />
    );
};

const ClusterFilter = React.memo((props: AppFilterProps) => {
    const getClusterDetail = (dest: ApplicationDestination, clusterList: Cluster[]): string => {
        const cluster = (clusterList || []).find(target => target.name === dest.name || target.server === dest.server);
        if (!cluster) {
            return dest.server || dest.name;
        }
        return formatClusterQueryParam(cluster);
    };

    const [clusters, loading, error] = useData(() => services.clusters.list());
    const clusterOptions = optionsFrom(
        Array.from(new Set(props.stats.destinations?.map(destination => getClusterDetail(destination, clusters)).filter(item => !!item))),
        props.pref.clustersFilter
    );

    return (
        <Filter
            label='CLUSTERS'
            selected={props.pref.clustersFilter}
            setSelected={s => props.onChange({...props.pref, clustersFilter: s})}
            field={true}
            options={clusterOptions}
            error={error.state}
            retry={error.retry}
            loading={loading}
        />
    );
});

const NamespaceFilter = (props: AppFilterProps) => {
    const namespaceOptions = optionsFrom(Array.from(new Set(props.stats.namespaces?.filter(item => !!item))), props.pref.namespacesFilter);
    return (
        <Filter
            label='NAMESPACES'
            selected={props.pref.namespacesFilter}
            setSelected={s => props.onChange({...props.pref, namespacesFilter: s})}
            field={true}
            options={namespaceOptions}
        />
    );
};

const RepoFilter = (props: AppFilterProps) => {
    const repoOptions = React.useMemo(() => optionsFrom(props.stats.repos || [], props.pref.reposFilter), [props.pref.reposFilter]);
    return <Filter label='REPOSITORIES' selected={props.pref.reposFilter} setSelected={s => props.onChange({...props.pref, reposFilter: s})} field={true} options={repoOptions} />;
};

const TargetRevisionFilter = (props: AppFilterProps) => {
    const targetRevisionOptions = React.useMemo(
        () => optionsFrom(Array.from(new Set(props.stats.revisions || [])), props.pref.targetRevisionFilter),
        [props.stats.revisions, props.pref.targetRevisionFilter]
    );
    return (
        <Filter
            label='TARGET REVISION'
            selected={props.pref.targetRevisionFilter}
            setSelected={s => props.onChange({...props.pref, targetRevisionFilter: s})}
            field={true}
            options={targetRevisionOptions}
        />
    );
};

const FavoriteFilter = (props: {value: boolean; onChange: (showFavorites: boolean) => void}) => {
    const onChange = (val: boolean) => {
        props.onChange(val);
    };
    return (
        <div
            className={`filter filter__item ${props.value ? 'filter__item--selected' : ''}`}
            style={{margin: '0.5em 0', marginTop: '0.5em'}}
            onClick={() => onChange(!props.value)}>
            <Checkbox
                value={!!props.value}
                onChange={onChange}
                style={{
                    marginRight: '8px'
                }}
            />
            <div style={{marginRight: '5px', textAlign: 'center', width: '25px'}}>
                <i style={{color: '#FFCE25'}} className='fas fa-star' />
            </div>
            <div className='filter__item__label'>Favorites Only</div>
        </div>
    );
};

const AutoSyncFilter = (props: AppFilterProps) => (
    <Filter
        label='AUTO SYNC'
        selected={props.pref.autoSyncFilter}
        setSelected={s => props.onChange({...props.pref, autoSyncFilter: s})}
        options={[
            {
                label: 'Enabled',
                icon: <i className='fa fa-circle-play' style={{color: COLORS.sync.synced}} />,
                count: props.stats.autoSyncEnabledCount
            },
            {
                label: 'Disabled',
                icon: <i className='fa fa-ban' style={{color: COLORS.sync.out_of_sync}} />,
                count: props.stats.total - props.stats.autoSyncEnabledCount
            }
        ]}
        collapsed={props.collapsed || false}
    />
);

function getOperationOptions(props: AppFilterProps) {
    const counts = new Map<string, number>();
    Object.values(OperationStateTitles).forEach(val => counts.set(val, props?.stats?.totalByOperationStatus?.[val] || 0));

    /**
     * Combine syncing, terminated (terminating), and deleting counts into a single count for syncing status.
     * Deleting and Terminating are considered syncing statuses. Terminating operations will always end in a
     * failed or error state.
     */
    const combinedSyncingCount = counts.get(OperationStateTitles.Syncing) + counts.get(OperationStateTitles.Terminated) + counts.get(OperationStateTitles.Deleting);

    return [
        {
            label: OperationStateTitles.Syncing,
            icon: <i className='fa fa-circle-notch' style={{color: COLORS.operation.running}} />,
            count: combinedSyncingCount
        },
        {
            label: OperationStateTitles.SyncOK,
            icon: <i className='fa fa-check-circle' style={{color: COLORS.operation.success}} />,
            count: counts.get(OperationStateTitles.SyncOK)
        },
        {
            label: OperationStateTitles.SyncError,
            icon: <i className='fa fa-exclamation-circle' style={{color: COLORS.operation.error}} />,
            count: counts.get(OperationStateTitles.SyncError)
        },
        {
            label: OperationStateTitles.SyncFailed,
            icon: <i className='fa fa-times-circle' style={{color: COLORS.operation.failed}} />,
            count: counts.get(OperationStateTitles.SyncFailed)
        },
        {
            label: OperationStateTitles.Unknown,
            icon: <i className='fa fa-question-circle' style={{color: COLORS.health.unknown}} />,
            count: counts.get(OperationStateTitles.Unknown)
        }
    ];
}

const OperationFilter = (props: AppFilterProps) => (
    <Filter
        label='OPERATION STATUS'
        selected={props.pref.operationFilter}
        setSelected={s => props.onChange({...props.pref, operationFilter: s})}
        options={getOperationOptions(props)}
        collapsed={props.collapsed || false}
    />
);

export const ApplicationsFilter = (props: AppFilterProps) => {
    const appliedFilter = [
        ...(props.pref.syncFilter || []),
        ...(props.pref.healthFilter || []),
        ...(props.pref.operationFilter || []),
        ...(props.pref.labelsFilter || []),
        ...(props.pref.annotationsFilter || []),
        ...(props.pref.projectsFilter || []),
        ...(props.pref.clustersFilter || []),
        ...(props.pref.namespacesFilter || []),
        ...(props.pref.reposFilter || []),
        ...(props.pref.targetRevisionFilter || []),
        ...(props.pref.autoSyncFilter || []),
        ...(props.pref.showFavorites ? ['favorites'] : []),
        ...(props.pref.annotationsFilter || [])
    ];

    const onClearFilter = () => {
        const newPref: AppsListPreferences = {...props.pref};
        AppsListPreferences.clearFilters(newPref);
        props.onChange(newPref);
    };

    return (
        <FiltersGroup title='Application filters' content={props.children} appliedFilter={appliedFilter} onClearFilter={onClearFilter} collapsed={props.collapsed}>
            <FavoriteFilter value={!!props.pref.showFavorites} onChange={val => props.onChange({...props.pref, showFavorites: val})} />
            <SyncFilter {...props} />
            <AppHealthFilter {...props} />
            <OperationFilter {...props} />
            <LabelsFilter {...props} />
            <AnnotationsFilter {...props} />
            <ProjectFilter {...props} />
            <ClusterFilter {...props} />
            <NamespaceFilter {...props} />
            <RepoFilter {...props} />
            <TargetRevisionFilter {...props} />
            <AutoSyncFilter {...props} collapsed={true} />
        </FiltersGroup>
    );
};

export const AppSetsFilter = (props: AppSetFilterProps) => {
    return (
        <FiltersGroup title='ApplicationSet filters' content={props.children} collapsed={props.collapsed}>
            <FavoriteFilter value={!!props.pref.showFavorites} onChange={val => props.onChange({...props.pref, showFavorites: val})} />
            <AppSetHealthFilter {...props} />
            <AppsetLabelsFilter apps={props.apps} pref={props.pref} onChange={labelsFilter => props.onChange({...props.pref, labelsFilter})} />
        </FiltersGroup>
    );
};
