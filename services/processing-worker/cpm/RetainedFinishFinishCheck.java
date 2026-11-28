import java.time.LocalDateTime;
import org.mpxj.*;
import org.mpxj.cpm.PrimaveraScheduler;

public class RetainedFinishFinishCheck {
    private static Duration hours(double value) {
        return Duration.getInstance(value, TimeUnit.HOURS);
    }
    private static Task task(ProjectFile project, String id, double h, ProjectCalendar calendar) {
        var task = project.addTask();
        task.setName(id);
        task.setActivityID(id);
        task.setActivityType(ActivityType.TASK_DEPENDENT);
        task.setActivityStatus(ActivityStatus.NOT_STARTED);
        task.setCalendar(calendar);
        task.setDuration(hours(h));
        task.setPlannedDuration(hours(h));
        task.setRemainingDuration(hours(h));
        return task;
    }
    static void verify(boolean completedOutOfSequence, double lag, boolean recentActual, String expectedIso, boolean shouldMatch) throws Exception {
        var project = new ProjectFile();
        var calendar = project.addDefaultBaseCalendar();
        project.setDefaultCalendar(calendar);
        var statusDate = LocalDateTime.parse("2026-02-02T08:00");
        var props = project.getProjectProperties();
        props.setStartDate(statusDate);
        props.setStatusDate(statusDate);
        props.setRelationshipLagCalendar(RelationshipLagCalendar.PREDECESSOR);
        var ongoing = task(project, "open driving predecessor", 40, calendar);
        var intermediate = task(project, "out-of-sequence chain link", 8, calendar);
        intermediate.addPredecessor(new Relation.Builder().predecessorTask(ongoing).type(RelationType.FINISH_START));
        if (completedOutOfSequence) {
            intermediate.setActivityStatus(ActivityStatus.COMPLETED);
            intermediate.setActualStart(LocalDateTime.parse(recentActual ? "2026-01-30T08:00" : "2026-01-19T08:00"));
            intermediate.setActualFinish(LocalDateTime.parse(recentActual ? "2026-01-30T17:00" : "2026-01-19T17:00"));
            intermediate.setActualDuration(hours(8));
            intermediate.setRemainingDuration(hours(0));
        }
        var successor = task(project, "finish-finish successor", 16, calendar);
        successor.addPredecessor(new Relation.Builder().predecessorTask(intermediate).type(RelationType.FINISH_FINISH).lag(hours(lag)));
        new PrimaveraScheduler().schedule(project, statusDate);
        var expected = LocalDateTime.parse(expectedIso);
        var observed = successor.getEarlyFinish();
        System.out.println("completed=" + completedOutOfSequence + ", recent actual=" + recentActual + ", lag=" + lag + ", intermediate=" + intermediate.getEarlyFinish() + ", successor=" + observed + ", expected=" + expected);
        if (shouldMatch && !expected.equals(observed)) throw new AssertionError("Expected the successor to finish at " + expected + " but got " + observed);
    }
    public static void main(String[] args) throws Exception {
        var verify = args.length == 0;
        verify(true, 0, false, "2026-02-06T17:00", verify);
        verify(true, 8, false, "2026-02-06T17:00", verify);
        verify(false, 8, false, "2026-02-10T17:00", verify);
        verify(false, 0, false, "2026-02-09T17:00", verify);
        verify(true, 8, true, "2026-02-09T17:00", verify);
        verify(true, -8, false, "2026-02-04T17:00", verify);
    }
}
