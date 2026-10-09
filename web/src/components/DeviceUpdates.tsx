import { Stack } from "@mantine/core";
import { useSession } from "../api/session";
import { Card } from "../ui";
import { MissingUpdatesTab } from "./DeviceSoftware";
import { WindowsUpdatesTab } from "./DeviceWindowsUpdates";

/**
 * The "Windows updates" tab: the Windows update state and history of the device (`updates:read`) and the
 * program updates missing from the catalog (`deployments:read`), each section under the permission it always had.
 */
export function UpdatesTab({ id, hostname, active }: { id: string; hostname: string; active: boolean }) {
  const { can } = useSession();
  return (
    <Stack gap="lg">
      {can("updates:read") && (
        <Card title="Windows updates" description="What Windows reports as missing, hidden or failed on this device.">
          <WindowsUpdatesTab id={id} active={active} />
        </Card>
      )}
      {can("deployments:read") && (
        <Card title="Missing program updates" description="Installed programs that have a newer version in your catalog.">
          <MissingUpdatesTab id={id} hostname={hostname} active={active} />
        </Card>
      )}
    </Stack>
  );
}
