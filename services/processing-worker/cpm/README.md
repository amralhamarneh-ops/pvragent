# Standalone XER simulation candidate

Runs the activity network locally using an MPXJ Primavera-style CPM engine. It does not use or launch Primavera P6. To run, provide Node 22+, Java 17+ with the source compiler module, curl, unzip and patch. Install the checksum-pinned library and its retained-logic correction using install.sh. The repository does not contain binaries or real project XERs.

```sh
sh install.sh /absolute/private/cpm
export PVR_MPXJ_CLASSPATH='/absolute/private/cpm/classes:/absolute/private/cpm/lib/*'
node run.mjs /private/preimpact.xer /private/changes.json
node --test run.test.mjs
```

The optional changes file maps existing unfinished task-dependent activity codes to explicitly justified additional working hours. The command first recalculates the original XER with no edits. It compares the project data date and finish, all activity date pairs and available scheduled float. Within a one-minute tolerance for numeric float, all controls must pass before the command tests the change. There is intentionally no processed/reference-file parameter. The impact output contains a separate set of changed activity and milestone records and movement in both calendar days and elapsed hours. The command creates no changed production programme and does not connect to a remote service. Logs and outputs may contain private programme details, so keep them in the approved workspace.

The main PVR case uses the authenticated processing worker; it is unavailable for shared guest cases, without a configured worker, or when the unchanged source does not match. Pulling the app into Rocket does not rebuild an independently deployed worker. Rebuild the existing worker image before testing the new control in Rocket. The simulation cannot add activity fragments yet and does not resource-level, certify delay entitlement, or reproduce arbitrary scheduling options. Reference schedules remain comparisons, never calculation inputs.
