import java.nio.file.*;
import java.nio.charset.*;
import java.util.*;
import java.time.*;
import org.mpxj.ActivityType;
import org.mpxj.Duration;
import org.mpxj.ProjectFile;
import org.mpxj.Task;
import org.mpxj.TimeUnit;
import org.mpxj.primavera.PrimaveraXERFileReader;
import org.mpxj.cpm.PrimaveraScheduler;

public class ScheduleCpm {
  static String s(Object o) {return o == null ? "" : o.toString();}
  static final double MAX_HOURS = 24 * 366 * 5;
  public static void main(String[] args) throws Exception {
    if (args.length != 2) throw new IllegalArgumentException("Required: XER path and duration delta TSV path");
    var reader = new PrimaveraXERFileReader();
    reader.setCharset(Charset.forName("windows-1252"));
    reader.setIgnoreErrors(false);
    List<ProjectFile> files;
    try (var in = Files.newInputStream(Path.of(args[0]))) { files = reader.readAll(in); }
    if (files.size() != 1) throw new IllegalArgumentException("Expected exactly one project.");
    var project = files.get(0);
    var props = project.getProjectProperties();
    if (props.getStatusDate() == null || props.getStartDate() == null) throw new IllegalArgumentException("The source project start date and data date are required.");
    var byCode = new HashMap<String, Task>();
    for (Task task: project.getTasks()) {
      var code = task.getActivityID();
      if (code != null && task.getActivityType() != null && byCode.putIfAbsent(code, task) != null)
        throw new IllegalArgumentException("Duplicate activity code.");
    }
    var changed = new HashSet<String>();
    for (var line : Files.readAllLines(Path.of(args[1]), StandardCharsets.UTF_8)) {
      if (line.isBlank()) continue;
      var val = line.split("\t", -1);
      if (val.length != 2 || !changed.add(val[0])) throw new IllegalArgumentException("Invalid or duplicate activity duration change.");
      var task = byCode.get(val[0]); var hours = Double.parseDouble(val[1]);
      if (task == null || task.getActivityType() != ActivityType.TASK_DEPENDENT || task.getActualFinish() != null
          || task.getRemainingDuration() == null || !(hours > 0 && hours <= MAX_HOURS))
        throw new IllegalArgumentException("Each change must be positive and target an unfinished task-dependent activity.");
      var existing = task.getRemainingDuration().convertUnits(TimeUnit.HOURS, task.getCalendar()).getDuration();
      var calendar = task.getEffectiveCalendar();
      task.setRemainingDuration(Duration.getInstance(existing + hours, TimeUnit.HOURS));
      if (task.getActualStart() == null) {
        // The forward pass reads both at-completion and planned duration for unstarted work.
        var total = Duration.getInstance(existing + hours, TimeUnit.HOURS);
        task.setDuration(total);
        task.setPlannedDuration(total);
      } else if (task.getDuration() != null) {
        var total = task.getDuration().convertUnits(TimeUnit.HOURS, calendar).getDuration();
        task.setDuration(Duration.getInstance(total + hours, TimeUnit.HOURS));
      }
    }
    var anchor = props.getStartDate();
    new PrimaveraScheduler().schedule(project, anchor);
    if (props.getScheduledFinish() == null) throw new IllegalStateException("No recalculated project finish.");
    System.out.println(String.join("\t","PROJECT", s(props.getStatusDate()), s(props.getScheduledFinish())));
    var ordered = new ArrayList<>(byCode.values());
    ordered.sort(Comparator.comparing(Task::getActivityID));
    for (Task t: ordered) {
      var floatHrs = t.getTotalSlack() == null ? "" : s(t.getTotalSlack().convertUnits(TimeUnit.HOURS, t.getCalendar()).getDuration());
      var code = Base64.getEncoder().encodeToString(t.getActivityID().getBytes(StandardCharsets.UTF_8));
      var earlyStart = t.getActualStart() != null ? t.getActualStart() : t.getEarlyStart();
      var earlyFinish = t.getActualFinish() != null ? t.getActualFinish() : t.getEarlyFinish();
      System.out.println(String.join("\t","TASK",code,s(earlyStart),s(earlyFinish),floatHrs,s(t.getCritical())));
    }
  }
}
