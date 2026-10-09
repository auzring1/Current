import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Anchor, Button, Checkbox, Group, Menu, Modal, Stack, Table, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import { api, errorMessage, type DeploymentPlan, type FleetUpdate } from "../api/client";
import { useSession } from "../api/session";
import { PRODUCT_NAME } from "../brand.generated";
import { DataTable, EmptyState, Icons, IconButton, Page, PageHeader, StatusPill, toast, type Column } from "../ui";

const KEY = ["software-updates"];

/** How many devices have an older copy, and which versions they run. */
const versions = (u: FleetUpdate) => [...new Set(u.devices.map((d) => d.installed_version))];

/** Queues one "update" deployment per package and scope for the devices that have an older version. */
function useDeploy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ items, confirm }: { items: FleetUpdate[]; confirm: boolean }) => {
      const results: { name: string; plan?: DeploymentPlan; error?: string }[] = [];
      for (const u of items) {
        for (const scope of ["machine", "user"] as const) {
          const ids = [...new Set(u.devices.filter((d) => d.scope === scope).map((d) => d.device_id))];
          if (ids.length === 0) continue;
          try {
            const plan = await api<DeploymentPlan>("POST", "/deployments", {
              name: `Update ${u.package_name} to ${u.latest_version}`,
              action: "update",
              package_id: u.package_id,
              scope,
              device_ids: ids,
              unverified_confirmed: confirm,
            });
            results.push({ name: u.package_name, plan });
          } catch (e) {
            results.push({ name: u.package_name, error: errorMessage(e) });
          }
        }
      }
      return results;
    },
    onSuccess: (results) => {
      for (const r of results) {
        if (r.error) toast.error(r.error, r.name);
        else toast.success(`${r.name}: update queued (${r.plan?.jobs ?? 0} job${r.plan?.jobs === 1 ? "" : "s"}). Follow it under Deployments.`);
      }
      void qc.invalidateQueries({ queryKey: ["deployments"] });
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

function Confirm({ items, busy, onCancel, onConfirm }: { items: FleetUpdate[]; busy: boolean; onCancel: () => void; onConfirm: (confirmed: boolean) => void }) {
  const unverified = items.filter((u) => !u.verified);
  const [ok, setOk] = useState(false);
  const devices = new Set(items.flatMap((u) => u.devices.map((d) => d.device_id))).size;
  return (
    <Modal opened onClose={onCancel} title={`Deploy ${items.length} update${items.length === 1 ? "" : "s"}`}>
      <Stack>
        <Table verticalSpacing={2} fz="sm" aria-label="Updates to deploy">
          <Table.Tbody>
            {items.map((u) => (
              <Table.Tr key={u.package_id}>
                <Table.Td>{u.package_name}</Table.Td>
                <Table.Td ff="monospace">→ {u.latest_version}</Table.Td>
                <Table.Td>
                  {u.devices.length} device{u.devices.length === 1 ? "" : "s"}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Text size="sm" c="dimmed">
          Each update becomes a signed job on every device that has an older version ({devices} device{devices === 1 ? "" : "s"} in total). Older copies the new installer does not replace by itself are removed first.
        </Text>
        {unverified.length > 0 && (
          <Alert color="yellow" icon={<Icons.Warning size={18} aria-hidden />} title="Unverified packages">
            <Checkbox
              label={`${unverified.map((u) => u.package_name).join(", ")} ${unverified.length === 1 ? "has" : "have"} not been tested by ${PRODUCT_NAME}. I accept deploying ${unverified.length === 1 ? "it" : "them"}; this is recorded in the audit log.`}
              checked={ok}
              onChange={(e) => setOk(e.currentTarget.checked)}
            />
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(ok)} loading={busy} disabled={unverified.length > 0 && !ok}>
            Deploy
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function DevicesModal({ update, onClose }: { update: FleetUpdate; onClose: () => void }) {
  return (
    <Modal opened onClose={onClose} title={`${update.package_name}: devices to update`} size="lg">
      <Table verticalSpacing={4} fz="sm" aria-label={`Devices with an older ${update.package_name}`}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Device</Table.Th>
            <Table.Th>Installed</Table.Th>
            <Table.Th>Latest</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {update.devices.map((d) => (
            <Table.Tr key={`${d.device_id}|${d.scope}|${d.installed_version}`}>
              <Table.Td>
                <Anchor component={Link} to={`/devices/${d.device_id}?tab=software-updates`} size="sm" onClick={onClose}>
                  {d.hostname}
                </Anchor>
              </Table.Td>
              <Table.Td ff="monospace">{d.installed_version}</Table.Td>
              <Table.Td ff="monospace">{update.latest_version}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Modal>
  );
}

/** Programs from the catalog that are out of date somewhere in the fleet, with a way to update every device at once. */
export function SoftwareUpdatesPage() {
  const { canOrg } = useSession();
  const q = useQuery({ queryKey: KEY, queryFn: () => api<{ items: FleetUpdate[] }>("GET", "/software/updates") });
  const deploy = useDeploy();
  const [confirm, setConfirm] = useState<FleetUpdate[] | null>(null);
  const [clear, setClear] = useState<(() => void) | null>(null);
  const [showDevices, setShowDevices] = useState<FleetUpdate | null>(null);
  const canAct = canOrg("deployments:write");

  const columns = useMemo<Column<FleetUpdate>[]>(
    () => [
      {
        id: "package",
        header: "Package",
        required: true,
        width: 260,
        value: (u) => u.package_name,
        cell: (u) => (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Anchor component={Link} to={`/catalog/${u.package_id}`} size="sm">
              {u.package_name}
            </Anchor>
            {!u.verified && (
              <StatusPill kind="warning" size="sm">
                Unverified
              </StatusPill>
            )}
          </span>
        ),
      },
      { id: "latest", header: "Latest version", width: 150, value: (u) => u.latest_version, cell: (u) => <span className="rnv-mono">{u.latest_version}</span> },
      {
        id: "installed",
        header: "Installed versions",
        width: 220,
        value: (u) => versions(u).join(", "),
        cell: (u) => <span className="rnv-mono">{versions(u).slice(0, 3).join(", ")}{versions(u).length > 3 ? ` +${versions(u).length - 3}` : ""}</span>,
      },
      {
        id: "devices",
        header: "Devices to update",
        width: 150,
        value: (u) => u.devices.length,
        cell: (u) => (
          <Anchor component="button" type="button" size="sm" onClick={() => setShowDevices(u)} aria-label={`Show the ${u.devices.length} devices that need ${u.package_name}`}>
            {u.devices.length} device{u.devices.length === 1 ? "" : "s"}
          </Anchor>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: 170,
        value: (u) => (u.deployable ? "update available" : "vendor updates"),
        cell: (u) =>
          u.deployable ? (
            <StatusPill kind="info" size="sm">
              Update available
            </StatusPill>
          ) : (
            <StatusPill kind="neutral" size="sm" title={u.reason}>
              Vendor updates
            </StatusPill>
          ),
        filter: { type: "select", options: [{ value: "update available", label: "Update available" }, { value: "vendor updates", label: "Vendor updates" }] },
      },
    ],
    [],
  );

  return (
    <Page>
      <PageHeader
        title="Software updates"
        description={`Programs from your catalog that have a newer version than the one installed on some devices. Apps that update themselves are left to their vendor unless you turned that off for the package. Updates come from packages you imported in the Catalog.`}
      />
      <DataTable<FleetUpdate>
        id="software-updates"
        label="Software updates"
        data={q.data?.items}
        loading={q.isLoading}
        error={q.error}
        columns={columns}
        rowId={(u) => u.package_id}
        rowTestId="software-update-row"
        rowLabel={(u) => u.package_name}
        searchPlaceholder="Search packages"
        exportName="software-updates"
        selectable={canAct ? (u) => u.deployable : false}
        empty={<EmptyState icon={<Icons.Success size={26} />} title="Everything is up to date" description="Every installed program that is in your catalog is at its newest allowed version on every device." />}
        bulkActions={(rows, clr) => (
          <Button size="compact-sm" onClick={() => (setClear(() => clr), setConfirm(rows.filter((u) => u.deployable)))}>
            Deploy updates
          </Button>
        )}
        rowActions={
          canAct
            ? (u) => (
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <IconButton label={`Actions for ${u.package_name}`} icon={<Icons.More size={16} aria-hidden />} size="sm" />
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item disabled={!u.deployable} onClick={() => setConfirm([u])}>
                      Update {u.devices.length} device{u.devices.length === 1 ? "" : "s"} to {u.latest_version}
                    </Menu.Item>
                    <Menu.Item onClick={() => setShowDevices(u)}>Show devices</Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              )
            : undefined
        }
      />
      {showDevices && <DevicesModal update={showDevices} onClose={() => setShowDevices(null)} />}
      {confirm && (
        <Confirm
          items={confirm}
          busy={deploy.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={(c) => deploy.mutate({ items: confirm, confirm: c }, { onSettled: () => (setConfirm(null), clear?.()) })}
        />
      )}
    </Page>
  );
}
