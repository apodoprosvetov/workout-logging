import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

// No default: event_id is always supplied by the caller (the event being
// deduped), not generated here (research.md #4).
@Entity('processed_events')
export class ProcessedEvent {
  @PrimaryColumn('uuid')
  eventId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  processedAt!: Date;
}
