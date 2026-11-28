# Standalone XER simulation candidate

Runs the activity network locally using an MPXJ Primavera-style CPM engine. It does not use or launch Primavera P6. To run, provide Node 22+, Java 17+ with the source compiler module, curl, unzip and patch. Install the checksum-pinned library and its retained-logic correction using install.sh. The repository does not contain binaries or real project XERs.

```sh
sh install.sh /absolute/private/cpm
export PVR_MPXJ_CLASSPATH='/absolute/private/cpm/classes:/absolute/private/cpm/lib/*'
node run.mjs /private/preimpact.xer /private/changes.json
node --test run.test.mjs
```

The optional changes file maps existing unfinished task-dependent activity codes to explicitly justified additional working hours. The command first recalculates the original XER with no edits. It compares the project data date and finish, all activity date pairs and available scheduled float. Within a one-minute tolerance for numeric float, all controls must pass before the command tests the change. There is intentionally no processed/reference-file parameter. The impact output contains a separate set of changed activity and milestone records and movement in both calendar days and elapsed hours. The command creates no changed production programme and does not connect to a remote service. Logs and outputs may contain private programme details, so keep them in the approved workspace.

The main PVR case uses the authenticated processing worker; it is unavailable for shared guest cases, without a configured worker, or when the unchanged source does not match. Pulling the app into Rocket does not rebuild an independently deployed worker. Rebuild the existing worker image before testing the new control in Rocket. The command-line input accepts duration edits only. The case interface also supports bounded new activities as described below. Neither resource-levels, certifies delay entitlement, nor reproduces arbitrary scheduling options. Reference schedules remain comparisons, never calculation inputs.

### New PVR journey

1. Complete the drawing comparison. The real case carries forward traceable takeoff items and holds unverified items; a confirmed BOQ is optional for schedule analysis.
2. Review the proposed activity mapping and confirm the selected code or explicit split. Enter a documented productivity figure in the displayed unit per working hour. Durations round up to a whole working minute. Extra time mapped to the same activity is added; no overlap or parallel crew saving is assumed.
3. For genuinely new work, use the proposed activity option and pick a predecessor and unstarted successor already linked by zero-lag finish-to-start logic. The new path uses the successor's calendar; it adds two FS ties and retains the original link. Two new tasks cannot share the same anchor pair, since that would silently assume parallel execution. Combinations outside this bounded case need a reviewed network. Omissions and complex rework are held, not turned into added days.
4. Run the unchanged control, then the scenario. The engine checks file identity, progress and start/finish/float agreement and reruns that control for every scenario. It also checks that constraints did not discard the added remaining time. Reviewed changes can consume float without moving completion. The UI separates working time, elapsed time and movement of the calendar date.
5. Compare the Gantt, milestones and engine-reported driving ties. A processed/reference XER may be viewed separately. Neither its dates nor its logic enter the independent run. In the PVR report the output is a what-if annex only, not an approved delay or EOT.

The current real journey sends version 2 requests to the worker. Rebuild the existing worker from the matching GitHub source; a successful sync of the Rocket editor alone does not enable version 2.
