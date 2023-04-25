import {Tooltip} from 'argo-ui/v2';
import * as React from 'react';
import {COLORS} from '../../../shared/components';
import {Consumer} from '../../../shared/context';
import * as models from '../../../shared/models';

import './applications-status-bar.scss';

export interface ApplicationsStatusBarProps {
    stats: models.ApplicationListStats;
}

export const ApplicationsStatusBar = ({stats}: ApplicationsStatusBarProps) => {
    const readings = [
        {
            name: 'Healthy',
            value: stats.totalByHealthStatus.Healthy || 0,
            color: COLORS.health.healthy
        },
        {
            name: 'Progressing',
            value: stats.totalByHealthStatus.Progressing || 0,
            color: COLORS.health.progressing
        },
        {
            name: 'Degraded',
            value: stats.totalByHealthStatus.Degraded || 0,
            color: COLORS.health.degraded
        },
        {
            name: 'Suspended',
            value: stats.totalByHealthStatus.Suspended || 0,
            color: COLORS.health.suspended
        },
        {
            name: 'Missing',
            value: stats.totalByHealthStatus.Missing || 0,
            color: COLORS.health.missing
        },
        {
            name: 'Unknown',
            value: stats.totalByHealthStatus.Unknown || 0,
            color: COLORS.health.unknown
        }
    ];

    // will sort readings by value greatest to lowest, then by name
    readings.sort((a, b) => (a.value < b.value ? 1 : a.value === b.value ? (a.name > b.name ? 1 : -1) : -1));

    const totalItems = readings.reduce((total, i) => {
        return total + i.value;
    }, 0);

    return (
        <Consumer>
            {() => (
                <>
                    {totalItems > 1 && (
                        <div className='status-bar'>
                            {readings &&
                                readings.length > 1 &&
                                readings.map((item, i) => {
                                    if (item.value > 0) {
                                        return (
                                            <div className='status-bar__segment' style={{backgroundColor: item.color, width: (item.value / totalItems) * 100 + '%'}} key={i}>
                                                <Tooltip content={`${item.value} ${item.name}`} inverted={true}>
                                                    <div className='status-bar__segment__fill' />
                                                </Tooltip>
                                            </div>
                                        );
                                    }
                                })}
                        </div>
                    )}
                </>
            )}
        </Consumer>
    );
};
