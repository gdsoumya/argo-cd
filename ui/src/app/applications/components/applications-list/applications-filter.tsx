import {useData, Checkbox} from 'argo-ui/v2';
import * as React from 'react';
import {Context} from '../../../shared/context';
import {ApplicationDestination, ApplicationListStats, Cluster, HealthStatusCode, HealthStatuses, SyncStatusCode, SyncStatuses} from '../../../shared/models';
import {AppsListPreferences, services} from '../../../shared/services';
import {Filter, FiltersGroup} from '../filter/filter';
import {formatClusterQueryParam} from '../../../shared/utils';
import {ComparisonStatusIcon, HealthStatusIcon} from '../utils';

const optionsFrom = (options: string[], filter: string[]) => {
    return options
        .filter(s => filter.indexOf(s) === -1)
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

const getOptions = (counts: {[key: string]: number}, keys: string[], getIcon?: (k: string) => React.ReactNode) => {
    return keys.map(k => {
        return {
            label: k,
            icon: getIcon && getIcon(k),
            count: counts && counts[k]
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

const HealthFilter = (props: AppFilterProps) => (
    <Filter
        label='HEALTH STATUS'
        selected={props.pref.healthFilter}
        setSelected={s => props.onChange({...props.pref, healthFilter: s})}
        options={getOptions(props.stats.totalByHealthStatus, Object.keys(HealthStatuses), s => (
            <HealthStatusIcon state={{status: s as HealthStatusCode, message: ''}} noSpin={true} />
        ))}
    />
);

const LabelsFilter = (props: AppFilterProps) => {
    const suggestions = new Array<string>();
    (props.stats.labels || []).forEach(labelStats => {
        suggestions.push(labelStats.key);
        labelStats.values.forEach(val => suggestions.push(`${labelStats.key}=${val}`));
    });
    const labelOptions = suggestions.map(s => {
        return {label: s};
    });

    return <Filter label='LABELS' selected={props.pref.labelsFilter} setSelected={s => props.onChange({...props.pref, labelsFilter: s})} field={true} options={labelOptions} />;
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

const ClusterFilter = (props: AppFilterProps) => {
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
};

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

const FavoriteFilter = (props: AppFilterProps) => {
    const ctx = React.useContext(Context);
    const onChange = (val: boolean) => {
        ctx.navigation.goto('.', {showFavorites: val}, {replace: true});
        services.viewPreferences.updatePreferences({appList: {...props.pref, showFavorites: val}});
    };
    return (
        <div
            className={`filter filter__item ${props.pref.showFavorites ? 'filter__item--selected' : ''}`}
            style={{margin: '0.5em 0', marginTop: '0.5em'}}
            onClick={() => onChange(!props.pref.showFavorites)}>
            <Checkbox
                value={!!props.pref.showFavorites}
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
                icon: <i className='fa fa-circle-play' />,
                count: props.stats.autoSyncEnabledCount
            },
            {
                label: 'Disabled',
                icon: <i className='fa fa-ban' />,
                count: props.stats.total - props.stats.autoSyncEnabledCount
            }
        ]}
        collapsed={props.collapsed || false}
    />
);

export const ApplicationsFilter = (props: AppFilterProps) => {
    return (
        <FiltersGroup title='Application filters' content={props.children} collapsed={props.collapsed}>
            <FavoriteFilter {...props} />
            <SyncFilter {...props} />
            <HealthFilter {...props} />
            <LabelsFilter {...props} />
            <ProjectFilter {...props} />
            <ClusterFilter {...props} />
            <NamespaceFilter {...props} />
            <AutoSyncFilter {...props} collapsed={true} />
        </FiltersGroup>
    );
};
