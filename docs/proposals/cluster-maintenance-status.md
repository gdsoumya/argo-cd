---
title: Cluster Maintenance Status
authors:
  - @gdsoumya
sponsors:
  - TBD        # List all interested parties here.
reviewers:
  - TBD
approvers:
  - TBD

creation-date: 2025-09-15
last-updated: 2025-09-15
---

# Cluster Maintenance Status

This proposal introduces cluster maintenance status functionality to help operators manage applications deployed to clusters with sporadic internet connectivity or clusters undergoing maintenance.

## Summary

This enhancement introduces three key features:
1. A maintenance mode for clusters that prevents reconciliation and marks cluster status as "Maintenance"
2. Configurable timeout duration for when cluster status changes to "Unknown" 
3. UI improvements to filter applications by cluster connection status and display cluster status indicators

These features enable operators to distinguish between clusters that are expected to be disconnected (maintenance) versus those that are unexpectedly disconnected, improving operational visibility and preventing stale application state overwrites.

## Motivation

Operators managing ArgoCD deployments face challenges with clusters that have sporadic connectivity or undergo scheduled maintenance:

1. **Sporadic Connectivity**: Some clusters have unreliable internet connections where agents periodically stop reporting status. Operators cannot distinguish between actual sync/health issues and stale status due to connectivity problems.

2. **Maintenance Windows**: Clusters are sometimes intentionally shut down for extended maintenance periods. During these windows, operators need to filter out applications from these clusters to focus on truly problematic deployments.

3. **State Preservation**: When clusters go offline while in a good state, continued reconciliation attempts may override the last known good application state when connectivity is restored.

4. **Operational Efficiency**: Operators need efficient ways to identify applications with genuine issues on clusters that should be online and connected.

### Goals

- **[G-1] Maintenance Mode**: Introduce a maintenance field in cluster secrets that prevents reconciliation and sets cluster status to "Maintenance"
- **[G-2] Configurable Unknown Timeout**: Make the "Unknown" cluster status timeout configurable both globally and per-cluster
- **[G-3] Cluster Status Filtering**: Add cluster connection status filters to the applications list page
- **[G-4] Status Indicators**: Display cluster connection status indicators in application list and details pages

### Non-Goals

- Automatic detection of maintenance mode based on cluster behavior
- Backup and restore functionality for application state during maintenance
- Advanced cluster health monitoring beyond connection status

## Proposal

### Cluster Maintenance Mode

Introduce a new `argocd.argoproj.io/maintenance` field in cluster secrets:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cluster-example
  labels:
    argocd.argoproj.io/secret-type: cluster
data:
  name: <cluster-name>
  server: <cluster-server>
  config: <cluster-config>
  # New maintenance field
  maintenance: "true"  # base64 encoded
```

When `maintenance` is set to `"true"`:
- Cluster status is forced to "Maintenance" regardless of controller reports
- Application controller stops reconciling applications targeted to this cluster
- Applications remain in their last known state until maintenance mode is disabled

### Configurable Unknown Timeout

Currently, cluster status changes to "Unknown" after a hard-coded 10-minute timeout. This proposal introduces:

**Global Configuration** in `argocd-cm`:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
data:
  # Global default timeout for cluster unknown status
  cluster.unknown.timeout: "10m"
```

**Per-Cluster Configuration** in cluster secrets:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cluster-example
  labels:
    argocd.argoproj.io/secret-type: cluster
data:
  name: <cluster-name>
  server: <cluster-server>
  config: <cluster-config>
  # Per-cluster timeout override
  unknown.timeout: "30m"  # base64 encoded
```

The per-cluster timeout takes precedence over the global setting.

### Application List Filtering

Add cluster connection status filter to the applications list page with the following options:
- **All Clusters** (default)
- **Successful** - clusters with successful connections
- **Failed** - clusters with failed connections  
- **Unknown** - clusters with unknown connection status
- **Maintenance** - clusters in maintenance mode

The filter should be persistent across browser sessions and integrate with existing application filters.

### Cluster Status Indicators

Add cluster connection status indicators to:

**Application List Page**:
- Small colored dot icon next to application name or destiantion name
- Color coding: Green (Successful), Red (Failed), Yellow (Unknown), Blue (Maintenance)
- Tooltip showing connection status

**Application Details Page**:
- Prominent status indicator in the application summary section with similar color coding as the list page.

### Use Cases

#### Use Case 1: Scheduled Maintenance
As an operator, I want to put a cluster into maintenance mode before scheduled downtime so that:
- ArgoCD stops trying to reconcile applications on that cluster which might fail and cause alerts
- The applications maintain their last known good state
- I can filter out applications on maintenance clusters when reviewing system health

#### Use Case 2: Sporadic Connectivity
As an operator managing edge clusters with unreliable connectivity, I want to:
- Set longer "Unknown" timeouts for clusters with known connectivity issues


#### Use Case 3: Operational Triage
As an operator responding to alerts, I want to:
- Filter the application list to show only applications on clusters that should be online
- Quickly identify cluster connection status when investigating application issues
- Focus troubleshooting efforts on genuinely problematic deployments

### Implementation Details/Notes/Constraints

**Controller Changes**:
- Modify cluster connection status logic to check maintenance field
- Implement configurable timeout for "Unknown" status
- Skip reconciliation for applications on clusters in maintenance mode

**API Changes**:
- Extend Application list/Get to support cluster status filtering
- Add cluster connection status to Application get/list responses

**UI Changes**:
- Add cluster status filter component to applications list page filter section
- Implement cluster status indicators with appropriate styling
- Add cluster status information to application details view


### Security Considerations

- The maintenance field in cluster secrets follows existing ArgoCD security patterns
- No new RBAC permissions are required beyond existing cluster secret management
- Cluster status information exposure is consistent with current ArgoCD behavior
- Configuration changes require appropriate admin permissions

### Upgrade / Downgrade Strategy

**Upgrade**:
- New fields in cluster secrets are optional and backward compatible
- Default behavior remains unchanged for existing clusters
- UI enhancements are additive and don't break existing workflows

**Downgrade**:
- Maintenance field is ignored by older ArgoCD versions
- Applications continue normal reconciliation behavior

**Migration**:
- No data migration required
- Existing cluster secrets work without modification
- Operators can gradually adopt new features as needed
