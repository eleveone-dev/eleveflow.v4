import { Json } from "../integrations/supabase/types";

export type Database = {
  public: {
    Tables: {
      accounts: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          email: string | null;
          whatsapp_status: string;
          whatsapp_session: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          email?: string | null;
          whatsapp_status?: string;
          whatsapp_session?: Json | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          email?: string | null;
          whatsapp_status?: string;
          whatsapp_session?: Json | null;
          created_at?: string;
        };
      };
      pipeline_stages: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          color: string;
          position: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          color?: string;
          position?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          color?: string;
          position?: number;
          created_at?: string;
        };
      };
      leads: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          phone: string;
          email: string | null;
          company: string | null;
          stage_id: string | null;
          active_flow_id: string | null;
          active_flow_step: number;
          flow_waiting_reply: boolean;
          tags: string[] | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          phone: string;
          email?: string | null;
          company?: string | null;
          stage_id?: string | null;
          active_flow_id?: string | null;
          active_flow_step?: number;
          flow_waiting_reply?: boolean;
          tags?: string[] | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          phone?: string;
          email?: string | null;
          company?: string | null;
          stage_id?: string | null;
          active_flow_id?: string | null;
          active_flow_step?: number;
          flow_waiting_reply?: boolean;
          tags?: string[] | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      flows: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          description: string | null;
          trigger_stage_id: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          description?: string | null;
          trigger_stage_id?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          description?: string | null;
          trigger_stage_id?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
      };
      flow_blocks: {
        Row: {
          id: string;
          user_id: string;
          flow_id: string;
          type: string;
          position: number;
          config: Json;
          next_block_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          flow_id: string;
          type: string;
          position?: number;
          config?: Json;
          next_block_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          flow_id?: string;
          type?: string;
          position?: number;
          config?: Json;
          next_block_id?: string | null;
          created_at?: string;
        };
      };
      messages: {
        Row: {
          id: string;
          user_id: string;
          lead_id: string;
          flow_id: string | null;
          block_id: string | null;
          direction: string;
          content: string;
          status: string;
          whatsapp_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          lead_id: string;
          flow_id?: string | null;
          block_id?: string | null;
          direction: string;
          content: string;
          status?: string;
          whatsapp_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          lead_id?: string;
          flow_id?: string | null;
          block_id?: string | null;
          direction?: string;
          content?: string;
          status?: string;
          whatsapp_id?: string | null;
          created_at?: string;
        };
      };
      send_queue: {
        Row: {
          id: string;
          user_id: string;
          lead_id: string;
          flow_id: string | null;
          block_id: string | null;
          scheduled_at: string;
          status: string;
          attempts: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          lead_id: string;
          flow_id?: string | null;
          block_id?: string | null;
          scheduled_at?: string;
          status?: string;
          attempts?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          lead_id?: string;
          flow_id?: string | null;
          block_id?: string | null;
          scheduled_at?: string;
          status?: string;
          attempts?: number;
          created_at?: string;
        };
      };
      objections: {
        Row: {
          id: string;
          user_id: string;
          lead_id: string;
          content: string;
          resolved: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          lead_id: string;
          content: string;
          resolved?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          lead_id?: string;
          content?: string;
          resolved?: boolean;
          created_at?: string;
        };
      };
      logs: {
        Row: {
          id: string;
          user_id: string;
          lead_id: string | null;
          flow_id: string | null;
          block_id: string | null;
          event: string;
          details: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          lead_id?: string | null;
          flow_id?: string | null;
          block_id?: string | null;
          event: string;
          details?: Json | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          lead_id?: string | null;
          flow_id?: string | null;
          block_id?: string | null;
          event?: string;
          details?: Json | null;
          created_at?: string;
        };
      };
    };
  };
};
