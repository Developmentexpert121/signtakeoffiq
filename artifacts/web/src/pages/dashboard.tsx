import { useGetDashboardSummary, useGetRecentJobs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { FileText, CheckCircle2, AlertTriangle, Layers, Loader2 } from "lucide-react";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Badge } from "@/components/ui/badge";

export default function Dashboard() {
  const { isMember, isGuest } = useCurrentUser();
  const canAct = isMember || isGuest;
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary();
  const { data: recentJobs, isLoading: loadingJobs } = useGetRecentJobs({ limit: 5 });

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8 max-w-7xl mx-auto w-full">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1">System overview and active extraction jobs.</p>
      </div>

      {loadingSummary ? (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      ) : summary ? (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <Card style={{ borderLeft: '3px solid hsl(var(--primary))' }}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle style={{ fontFamily: "'IBM Plex Sans'", fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }} className="text-muted-foreground font-medium">Total Jobs</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div style={{ fontFamily: "'Chakra Petch'", color: 'hsl(var(--primary))', fontSize: '2rem', fontWeight: 700, lineHeight: 1.1 }}>{summary.totalJobs}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {summary.activeJobs} active • {summary.completedJobs} completed
              </p>
            </CardContent>
          </Card>
          
          <Card style={{ borderLeft: '3px solid hsl(var(--primary))' }}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle style={{ fontFamily: "'IBM Plex Sans'", fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }} className="text-muted-foreground font-medium">Total Signs Extracted</CardTitle>
              <Layers className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div style={{ fontFamily: "'Chakra Petch'", color: 'hsl(var(--primary))', fontSize: '2rem', fontWeight: 700, lineHeight: 1.1 }}>{summary.totalSigns.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground mt-1">Across all completed jobs</p>
            </CardContent>
          </Card>

          <Card style={{ borderLeft: '3px solid hsl(var(--primary))' }}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle style={{ fontFamily: "'IBM Plex Sans'", fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }} className="text-muted-foreground font-medium">Review Queue</CardTitle>
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div style={{ fontFamily: "'Chakra Petch'", color: 'hsl(var(--primary))', fontSize: '2rem', fontWeight: 700, lineHeight: 1.1 }}>{summary.totalNeedsReview.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Signs requiring human validation
              </p>
            </CardContent>
          </Card>

          <Card style={{ borderLeft: '3px solid hsl(var(--primary))' }}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle style={{ fontFamily: "'IBM Plex Sans'", fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }} className="text-muted-foreground font-medium">High Confidence</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            </CardHeader>
            <CardContent>
              <div style={{ fontFamily: "'Chakra Petch'", color: 'hsl(var(--primary))', fontSize: '2rem', fontWeight: 700, lineHeight: 1.1 }}>{summary.totalHighConfidence.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {summary.totalSigns > 0 ? Math.round((summary.totalHighConfidence / summary.totalSigns) * 100) : 0}% auto-validation rate
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div>
        <Card>
          <CardHeader>
            <CardTitle>Recent Jobs</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingJobs ? (
              <div className="space-y-4">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : recentJobs && recentJobs.length > 0 ? (
              <div className="space-y-4">
                {recentJobs.map(job => (
                  <Link key={job.id} href={`/jobs/${job.id}`}>
                    <div className="flex items-center justify-between gap-3 p-4 rounded-lg border bg-card hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer group">
                      <div className="flex flex-col gap-1 min-w-0">
                        <span className="font-semibold group-hover:underline truncate">{job.name}</span>
                        <span className="text-xs text-muted-foreground truncate">
                          {job.location || 'No location'} • {new Date(job.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                        <div className="text-right hidden sm:block">
                          <div className="text-sm font-medium">{job.totalSigns} signs</div>
                          <div className="text-xs text-muted-foreground">{job.needsReview} pending</div>
                        </div>
                        <Badge variant={
                          job.status === 'completed' ? 'default' :
                          job.status === 'processing' ? 'secondary' :
                          job.status === 'error' ? 'destructive' : 'outline'
                        } className="capitalize">
                          {job.status === 'processing' && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                          {job.status}
                        </Badge>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <FileText className="h-10 w-10 text-muted-foreground mb-4 opacity-50" />
                <p className="text-muted-foreground">No jobs found.</p>
                {canAct && (
                  <Link href="/jobs/new" className="text-primary mt-2 hover:underline text-sm font-medium">Create your first job</Link>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
