# Privacy

Liaison does not intentionally record or retain call audio and does not enable Twilio call recording. Twilio ConversationRelay and its configured transcription/TTS providers necessarily process telephone audio to transcribe representative speech and synthesize Liaison speech.

SQLite stores the case narrative, approved brief, disclosure-card metadata, call state, redacted transcript text, approvals, audit events, duration/cost estimate, and outcome report. Server logs are structured and redacted but remain sensitive operational data that should be access-controlled.

Temporary disclosure values are stored only in server process memory. They are not stored in SQLite, ordinary logs, SSE events, error text, or OpenAI input. The model sees label, category, purposes, permission, and allowed channel only. Stored transcripts use `[REDACTED:CATEGORY:LABEL]`. Values are cleared when the call ends, the case is deleted, the process shuts down, or the process loses the associated call. A restart makes the value unrecoverable.

When OpenAI mode is enabled, OpenAI receives the structured case context and redacted transcript text necessary for planning, control, or outcome extraction, but no disclosure-card values. In mock mode, no OpenAI request is attempted. Consult the provider's current data-control terms for the selected project.

Participants hear an automated-assistant and real-time-transcription disclosure before substantive human conversation. Liaison accurately says only that this application is not recording audio; it does not claim providers avoid audio processing.

`DATA_RETENTION_DAYS` controls completed-case retention. Run `npm run retention` from a scheduler of your choice; no background scheduler or external backup service is included. Deleting a case cascades through calls, transcripts, approvals, events, and outcomes. Backups made before deletion may retain data and must have their own retention policy.

Users should not enter prohibited credentials. This is not an emergency, legal, medical, financial, insurance, or government service.
