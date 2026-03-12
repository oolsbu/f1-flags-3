export interface RaceControl {
  meeting_key: number;
  session_key: number;
  date: string;
  driver_number: number | null;
  lap_number: number | null;
  category: string;
  flag: string | number | null;
  scope: string | null;
  sector: string | null;
  qualifying_phase: string | null;
  message: string;
}
