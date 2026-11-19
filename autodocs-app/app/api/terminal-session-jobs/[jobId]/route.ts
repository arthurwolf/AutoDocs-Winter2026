import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/app/lib/server/db';
import { deleteMlJob, MlJobNotFoundError, readMlJob } from '@/app/lib/server/ml-jobs';
import { isLocalCpuJobsEnabled } from '@/app/lib/server/processing-mode';
import { getRequestUser } from '@/app/lib/server/request-auth';

interface JobRow { id: string; title: string; duration_seconds: number; terminal_session_id: string | null; }

export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const user = await getRequestUser(request);
  if (!user) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  if (!isLocalCpuJobsEnabled()) return NextResponse.json({ message: 'Local CPU job processing is disabled.' }, { status: 409 });
  const { jobId } = await params;
  const row = (await db.query<JobRow>(`SELECT id, title, duration_seconds, terminal_session_id FROM terminal_session_jobs WHERE id = $1 AND user_id = $2`, [jobId, user.id])).rows[0];
  if (!row) return NextResponse.json({ message: 'Upload job not found.' }, { status: 404 });
  try {
    const job = await readMlJob(jobId);
    await db.query(`UPDATE terminal_session_jobs SET status = $2, progress_percent = $3, error_message = $4, updated_at = NOW() WHERE id = $1`, [jobId, job.status, job.percent, job.error]);
    if (job.status !== 'completed' || !job.result || row.terminal_session_id) return NextResponse.json({ job, terminalSessionId: row.terminal_session_id });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query<JobRow>(`SELECT id, title, duration_seconds, terminal_session_id FROM terminal_session_jobs WHERE id = $1 FOR UPDATE`, [jobId])).rows[0];
      if (!locked.terminal_session_id) {
        const content = JSON.stringify({
          version: 2,
          events: job.result.content.map((item) => {
            const parsed = JSON.parse(item) as {
              summary: string;
              depth: number;
              xml?: string;
            };

            return {
              label: parsed.summary,
              depth: parsed.depth,
              content: typeof parsed.xml === 'string' ? parsed.xml : null,
            };
          }),
        });
        const session = (await client.query<{ id: string }>(`INSERT INTO terminal_sessions (title, duration_seconds, content) VALUES ($1, $2, $3) RETURNING id`, [locked.title, locked.duration_seconds, content])).rows[0];
        await client.query(`INSERT INTO terminal_session_access (user_id, terminal_session_id, owner) VALUES ($1, $2, TRUE)`, [user.id, session.id]);
        await client.query(`UPDATE terminal_session_jobs SET terminal_session_id = $2, updated_at = NOW() WHERE id = $1`, [jobId, session.id]);
        locked.terminal_session_id = session.id;
      }
      await client.query('COMMIT');
      return NextResponse.json({ job, terminalSessionId: locked.terminal_session_id });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } catch (error) { return NextResponse.json({ message: error instanceof Error ? error.message : 'Could not read upload job.' }, { status: 502 }); }
}


export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const user = await getRequestUser(request);
  if (!user) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });

  if (!isLocalCpuJobsEnabled()) {
    return NextResponse.json({ message: 'Local CPU jobs are disabled.' }, { status: 409 });
  }

  const { jobId } = await params;

  const row = (await db.query<{ id: string; status: string; terminal_session_id: string | null }>(
    `SELECT id, status, terminal_session_id FROM terminal_session_jobs WHERE id = $1 AND user_id = $2`,
    [jobId, user.id],
  )).rows[0];

  if (!row) {
    return NextResponse.json({ message: 'Upload job not found.' }, { status: 404 });
  }

  if (row.terminal_session_id) {
    return NextResponse.json(
      { message: 'Saved terminal sessions cannot be deleted here.' },
      { status: 409 },
    );
  }

  try {
    let alreadyMissing = false;

    try {
      const job = await readMlJob(jobId);
      if (job.status !== 'failed') {
        return NextResponse.json(
          { message: 'Only failed jobs can be deleted.' },
          { status: 409 },
        );
      }

      await db.query(
        `UPDATE terminal_session_jobs
         SET status = 'failed', error_message = $3, updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND terminal_session_id IS NULL`,
        [jobId, user.id, job.error],
      );
    } catch (error) {
      if (error instanceof MlJobNotFoundError) {
        alreadyMissing = true;
      } else {
        throw error;
      }
    }

    if (alreadyMissing && row.status !== 'failed') {
      return NextResponse.json(
        { message: 'Cannot delete an unverified missing ML job.' },
        { status: 409 },
      );
    }

    if (!alreadyMissing) {
      await deleteMlJob(jobId);
    }

    const deleted = await db.query(
      `DELETE FROM terminal_session_jobs
       WHERE id = $1 AND user_id = $2 AND terminal_session_id IS NULL`,
      [jobId, user.id],
    );

    if (deleted.rowCount !== 1) {
      throw new Error('Could not remove the upload job from PostgreSQL.');
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : 'Could not delete job.' },
      { status: 502 },
    );
  }
}
