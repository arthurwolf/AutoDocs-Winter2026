"use client";

import { IconAlertTriangle, IconCheck, IconCloudUpload, IconLoader2, IconX } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { UploadProgressPanel } from '@/app/components/UploadProgressPanel';
import type { MlJobStatus } from '@/app/lib/server/ml-jobs';

type UploadState = 'idle' | 'registering' | 'processing' | 'success' | 'error';

interface LegacyUploadResponse {
    terminalSession?: { id: string };
    message?: string;
}

interface JobAvailabilityResponse {
    enabled?: boolean;
    job?: MlJobStatus | null;
}

interface UploadTileProperties {
    onUploadSuccess?: () => void;
}

/** Uploads recordings through the configured legacy or local-CPU protocol. */
export function UploadTile({ onUploadSuccess }: UploadTileProperties) {
    const [isDragging, setIsDragging] = useState(false);
    const [authenticationExpired, setAuthenticationExpired] = useState(false);
    const isPollingReference = useRef(false);
    const [isDeletingJob, setIsDeletingJob] = useState(false);
    const [uploadState, setUploadState] = useState<UploadState>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [job, setJob] = useState<MlJobStatus | null>(null);
    const [isLocalCpuJobsEnabled, setIsLocalCpuJobsEnabled] = useState(false);
    const [isProcessingModeResolved, setIsProcessingModeResolved] = useState(false);
    const fileInputReference = useRef<HTMLInputElement>(null);
    const notifiedJobReference = useRef<string | null>(null);
    const onUploadSuccessReference = useRef(onUploadSuccess);

    useEffect(() => {
        onUploadSuccessReference.current = onUploadSuccess;
    }, [onUploadSuccess]);

    const pollJob = useCallback(async (jobId: string): Promise<void> => {
        const url = `/api/terminal-session-jobs/${encodeURIComponent(jobId)}`;
        let response = await fetch(url, { cache: 'no-store' });

        if (response.status === 401) {
            const refreshResponse = await fetch('/api/auth/me', {
                cache: 'no-store',
                credentials: 'same-origin',
            });

            if (!refreshResponse.ok) {
                setAuthenticationExpired(true);
                throw new Error(
                    'Your login expired. Sign in again to view progress. The analysis may still be running.',
                );
            }

            response = await fetch(url, { cache: 'no-store' });

            if (response.status === 401) {
                setAuthenticationExpired(true);
                throw new Error('Please sign in again to view analysis progress.');
            }
        }

        const body = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(body.message ?? `Progress check failed with status ${response.status}`);
        }

        const nextJob = body.job as MlJobStatus;
        setJob(nextJob);

        if (nextJob.status === 'queued' || nextJob.status === 'running') {
            setErrorMessage(null);
            setUploadState('processing');
        }

        if (nextJob.status === 'failed') {
            setErrorMessage(nextJob.error ?? 'Analysis failed.');
            setUploadState('error');
        }

        if (nextJob.status === 'completed') {
            setUploadState('success');

            if (notifiedJobReference.current !== jobId) {
                notifiedJobReference.current = jobId;
                onUploadSuccessReference.current?.();
            }
        }
    }, []);

    useEffect(() => {
        let isDisposed = false;

        const resumeJob = async (): Promise<void> => {
            try {
                let response = await fetch('/api/terminal-session-jobs', { cache: 'no-store' });

                if (response.status === 401) {
                    const refreshResponse = await fetch('/api/auth/me', {
                        cache: 'no-store',
                        credentials: 'same-origin',
                    });

                    if (refreshResponse.ok) {
                        response = await fetch('/api/terminal-session-jobs', {
                            cache: 'no-store',
                        });
                    }
                }

                if (response.status === 401) {
                    if (!isDisposed) {
                        setAuthenticationExpired(true);
                        setErrorMessage('Your login expired. Sign in again to resume progress.');
                        setUploadState('error');
                        setIsProcessingModeResolved(true);
                    }
                    return;
                }

                if (response.status === 404) {
                    // Older deployments may not provide the job-status API.
                    if (!isDisposed) setIsProcessingModeResolved(true);
                    return;
                }

                if (!response.ok) {
                    throw new Error(`Could not resume job (${response.status}).`);
                }

                const body = await response.json() as JobAvailabilityResponse;

                if (isDisposed) {
                    return;
                }

                setIsLocalCpuJobsEnabled(body.enabled === true);
                setIsProcessingModeResolved(true);

                if (body.enabled && body.job) {
                    setJob(body.job);
                    if (body.job.status === 'failed') {
                        setErrorMessage(body.job.error ?? 'Analysis failed.');
                        setUploadState('error');
                    } else if (body.job.status === 'completed') {
                        // The detail endpoint persists completed results in PostgreSQL.
                        // This is also needed after the browser was closed during analysis.
                        await pollJob(body.job.id);
                    } else {
                        setUploadState('processing');
                    }
                }
            } catch (error) {
                if (!isDisposed) {
                    setErrorMessage(
                        error instanceof Error
                            ? error.message
                            : 'Could not restore analysis status.',
                    );
                    setUploadState('error');
                    setIsProcessingModeResolved(true);
                }
            }
        };

        void resumeJob();

        return () => {
            isDisposed = true;
        };
    }, [pollJob]);

    useEffect(() => {
        if (!job || authenticationExpired || ['completed', 'failed'].includes(job.status)) {
            return;
        }

        const timer = setInterval(() => {
            if (isPollingReference.current) return;
            isPollingReference.current = true;

            void pollJob(job.id)
                .catch((error: unknown) => {
                    setErrorMessage(error instanceof Error ? error.message : 'Unable to read upload progress.');
                    setUploadState('error');
                })
                .finally(() => {
                    isPollingReference.current = false;
                });
        }, 1000);

        return () => clearInterval(timer);
    }, [job, pollJob, authenticationExpired]);

    const validateAndReadFile = async (file: File): Promise<{ title: string; durationSeconds: number; content: string }> => {
        if (file.name.split('.').pop()?.toLowerCase() !== 'cast') {
            throw new Error('Unsupported file type. Please upload a .cast file.');
        }

        const content = await file.text();
        const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);

        if (lines.length < 2) {
            throw new Error('Invalid .cast file format.');
        }

        const lastEvent = JSON.parse(lines.at(-1) ?? '');

        if (!Array.isArray(lastEvent) || typeof lastEvent[0] !== 'number') {
            throw new Error('Failed to parse duration from .cast file.');
        }

        return {
            title: file.name.replace(/\.[^/.]+$/, ''),
            durationSeconds: Math.round(lastEvent[0]),
            content,
        };
    };

    const uploadThroughLegacyEndpoint = async (input: { title: string; durationSeconds: number; content: string }): Promise<void> => {
        setUploadState('processing');

        const response = await fetch('/api/terminal-sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        const body = await response.json().catch(() => ({})) as LegacyUploadResponse;

        if (!response.ok) {
            throw new Error(body.message ?? `Could not process upload (${response.status}).`);
        }

        setUploadState('success');
        onUploadSuccess?.();
    };

    const uploadThroughLocalCpuJobs = async (input: { title: string; durationSeconds: number; content: string }): Promise<void> => {
        const response = await fetch('/api/terminal-session-jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        const body = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(body.message ?? `Could not start analysis (${response.status}).`);
        }

        setJob(body.job as MlJobStatus);
        setUploadState('processing');
    };

    const handleFileUpload = async (file: File): Promise<void> => {
        setUploadState('registering');
        setErrorMessage(null);
        setJob(null);

        try {
            const input = await validateAndReadFile(file);

            if (isLocalCpuJobsEnabled) {
                await uploadThroughLocalCpuJobs(input);
            } else {
                await uploadThroughLegacyEndpoint(input);
            }
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : 'Upload failed.');
            setUploadState('error');
        }
    };

    const removeFailedJob = async (): Promise<void> => {
        if (!job || job.status !== 'failed' || isDeletingJob) return;

        if (!window.confirm('Delete this failed analysis and its uploaded recording?')) {
            return;
        }

        setIsDeletingJob(true);

        try {
            const response = await fetch(
                `/api/terminal-session-jobs/${encodeURIComponent(job.id)}`,
                { method: 'DELETE' },
            );

            const body = await response.json().catch(() => ({})) as {
                message?: string;
            };

            if (!response.ok) {
                throw new Error(body.message ?? 'Could not delete failed analysis.');
            }

            setJob(null);
            setErrorMessage(null);
            setUploadState('idle');
        } catch (error) {
            setErrorMessage(
                error instanceof Error ? error.message : 'Could not delete failed analysis.',
            );
            setUploadState('error');
        } finally {
            setIsDeletingJob(false);
        }
    };

    const isBusy = !isProcessingModeResolved || authenticationExpired || ['registering', 'processing'].includes(uploadState);
    const isLocalJob = isLocalCpuJobsEnabled && uploadState === 'processing';
    const title = !isProcessingModeResolved
        ? 'Checking upload configuration…'
        : uploadState === 'registering'
        ? 'Preparing upload…'
        : uploadState === 'processing'
            ? isLocalJob ? 'Analysis continues in the background' : 'Processing upload…'
            : uploadState === 'success'
                ? 'Session saved'
                : uploadState === 'error'
                    ? authenticationExpired ? 'Sign in to resume progress' : 'Upload failed'
                    : 'Upload Session';
    const subtitle = !isProcessingModeResolved
        ? 'Preparing the configured upload workflow.'
        : uploadState === 'registering'
        ? isLocalCpuJobsEnabled ? 'Saving your upload as a durable analysis job.' : 'Reading your recording.'
        : uploadState === 'processing'
            ? isLocalJob ? 'You can safely keep this page open or reload it; detailed progress is below.' : 'The configured analyzer is processing this recording.'
            : uploadState === 'success'
                ? 'Your annotated session is ready.'
                : uploadState === 'error'
                    ? errorMessage
                    : 'Drop an asciinema .cast recording here or click to browse.';
    const icon = uploadState === 'success'
        ? <IconCheck className="text-emerald-400" size={30} />
        : uploadState === 'error'
            ? <IconAlertTriangle className="text-destructive" size={30} />
            : isBusy
                ? <IconLoader2 className="text-primary animate-spin" size={30} />
                : <IconCloudUpload className="text-primary" size={30} />;

    return (
        <div className="space-y-4">
            <div
                className={`bg-card rounded-xl border-2 border-dashed p-6 transition-all ${isBusy ? 'cursor-wait border-primary/50' : isDragging ? 'cursor-copy border-primary bg-primary/5' : 'cursor-pointer border-border hover:border-primary'}`}
                onDragOver={(event) => {
                    event.preventDefault();
                    setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(event) => {
                    event.preventDefault();
                    setIsDragging(false);

                    if (!isBusy && event.dataTransfer.files[0]) {
                        void handleFileUpload(event.dataTransfer.files[0]);
                    }
                }}
                onClick={() => !isBusy && fileInputReference.current?.click()}
            >
                <input
                    ref={fileInputReference}
                    type="file"
                    className="hidden"
                    accept=".cast"
                    onChange={(event) => {
                        const file = event.target.files?.[0];

                        if (file) {
                            void handleFileUpload(file);
                        }

                        event.target.value = '';
                    }}
                />
                <div className="flex flex-col items-center justify-center min-h-[200px]">
                    <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">{icon}</div>
                    <h3 className="text-foreground mb-2">{title}</h3>
                    <p className={`text-sm text-center max-w-sm ${uploadState === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{subtitle}</p>
                    {!isBusy && uploadState !== 'success' && <span className="mt-4 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm">Choose .cast file</span>}
                </div>
            </div>
            {job?.status === 'failed' && (
                <div className="flex justify-end">
                    <button
                        type="button"
                        disabled={isDeletingJob}
                        onClick={() => void removeFailedJob()}
                        aria-label="Delete failed analysis"
                        title="Delete failed analysis"
                        className="inline-flex items-center gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                        <IconX size={18} />
                        {isDeletingJob ? 'Deleting…' : 'Remove failed analysis'}
                    </button>
                </div>
            )}
            {job && <UploadProgressPanel job={job} />}
        </div>
    );
}
