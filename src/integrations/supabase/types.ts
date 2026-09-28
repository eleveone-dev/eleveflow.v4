export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      account_secrets: {
        Row: {
          created_at: string;
          integrations: Json;
          updated_at: string;
          user_id: string;
          whatsapp_session: Json | null;
        };
        Insert: {
          created_at?: string;
          integrations?: Json;
          updated_at?: string;
          user_id: string;
          whatsapp_session?: Json | null;
        };
        Update: {
          created_at?: string;
          integrations?: Json;
          updated_at?: string;
          user_id?: string;
          whatsapp_session?: Json | null;
        };
        Relationships: [];
      };
      accounts: {
        Row: {
          created_at: string | null;
          email: string | null;
          id: string;
          name: string;
          onboarding_completed: boolean | null;
          settings: Json | null;
          user_id: string;
          whatsapp_number: string | null;
          whatsapp_status: string | null;
        };
        Insert: {
          created_at?: string | null;
          email?: string | null;
          id?: string;
          name: string;
          onboarding_completed?: boolean | null;
          settings?: Json | null;
          user_id: string;
          whatsapp_number?: string | null;
          whatsapp_status?: string | null;
        };
        Update: {
          created_at?: string | null;
          email?: string | null;
          id?: string;
          name?: string;
          onboarding_completed?: boolean | null;
          settings?: Json | null;
          user_id?: string;
          whatsapp_number?: string | null;
          whatsapp_status?: string | null;
        };
        Relationships: [];
      };
      campaigns: {
        Row: {
          channel: string | null;
          created_at: string;
          ends_at: string | null;
          id: string;
          metadata: Json;
          name: string;
          objective: string | null;
          starts_at: string | null;
          status: string;
          user_id: string;
          workspace_id: string | null;
        };
        Insert: {
          channel?: string | null;
          created_at?: string;
          ends_at?: string | null;
          id?: string;
          metadata?: Json;
          name: string;
          objective?: string | null;
          starts_at?: string | null;
          status?: string;
          user_id: string;
          workspace_id?: string | null;
        };
        Update: {
          channel?: string | null;
          created_at?: string;
          ends_at?: string | null;
          id?: string;
          metadata?: Json;
          name?: string;
          objective?: string | null;
          starts_at?: string | null;
          status?: string;
          user_id?: string;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "campaigns_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      extraction_history: {
        Row: {
          created_at: string | null;
          id: string;
          location: string | null;
          query: string;
          results_count: number | null;
          user_id: string;
        };
        Insert: {
          created_at?: string | null;
          id?: string;
          location?: string | null;
          query: string;
          results_count?: number | null;
          user_id: string;
        };
        Update: {
          created_at?: string | null;
          id?: string;
          location?: string | null;
          query?: string;
          results_count?: number | null;
          user_id?: string;
        };
        Relationships: [];
      };
      flow_blocks: {
        Row: {
          config: Json | null;
          created_at: string | null;
          flow_id: string;
          id: string;
          next_block_id: string | null;
          position: number | null;
          type: string;
          user_id: string;
        };
        Insert: {
          config?: Json | null;
          created_at?: string | null;
          flow_id: string;
          id?: string;
          next_block_id?: string | null;
          position?: number | null;
          type: string;
          user_id: string;
        };
        Update: {
          config?: Json | null;
          created_at?: string | null;
          flow_id?: string;
          id?: string;
          next_block_id?: string | null;
          position?: number | null;
          type?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "flow_blocks_flow_id_fkey";
            columns: ["flow_id"];
            isOneToOne: false;
            referencedRelation: "flows";
            referencedColumns: ["id"];
          },
        ];
      };
      flow_executions: {
        Row: {
          context: Json;
          created_at: string;
          current_block_id: string | null;
          flow_id: string;
          id: string;
          is_test: boolean | null;
          lead_id: string;
          scheduled_at: string | null;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          context?: Json;
          created_at?: string;
          current_block_id?: string | null;
          flow_id: string;
          id?: string;
          is_test?: boolean | null;
          lead_id: string;
          scheduled_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          context?: Json;
          created_at?: string;
          current_block_id?: string | null;
          flow_id?: string;
          id?: string;
          is_test?: boolean | null;
          lead_id?: string;
          scheduled_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "flow_executions_current_block_id_fkey";
            columns: ["current_block_id"];
            isOneToOne: false;
            referencedRelation: "flow_blocks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flow_executions_flow_id_fkey";
            columns: ["flow_id"];
            isOneToOne: false;
            referencedRelation: "flows";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flow_executions_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
        ];
      };
      flows: {
        Row: {
          canvas_state: Json | null;
          created_at: string | null;
          description: string | null;
          id: string;
          is_active: boolean | null;
          name: string;
          trigger_stage_id: string | null;
          trigger_type: string | null;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          canvas_state?: Json | null;
          created_at?: string | null;
          description?: string | null;
          id?: string;
          is_active?: boolean | null;
          name: string;
          trigger_stage_id?: string | null;
          trigger_type?: string | null;
          updated_at?: string | null;
          user_id: string;
        };
        Update: {
          canvas_state?: Json | null;
          created_at?: string | null;
          description?: string | null;
          id?: string;
          is_active?: boolean | null;
          name?: string;
          trigger_stage_id?: string | null;
          trigger_type?: string | null;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "flows_trigger_stage_id_fkey";
            columns: ["trigger_stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
        ];
      };
      global_settings: {
        Row: {
          created_at: string | null;
          key: string;
          updated_at: string | null;
          value: string;
        };
        Insert: {
          created_at?: string | null;
          key: string;
          updated_at?: string | null;
          value: string;
        };
        Update: {
          created_at?: string | null;
          key?: string;
          updated_at?: string | null;
          value?: string;
        };
        Relationships: [];
      };
      leads: {
        Row: {
          about: string | null;
          active_flow_id: string | null;
          active_flow_step: number | null;
          address: string | null;
          all_photos: Json | null;
          attribution: Json;
          category: string | null;
          company: string | null;
          cover_photo_url: string | null;
          created_at: string | null;
          email: string | null;
          enriched_at: string | null;
          facade_photo_url: string | null;
          first_campaign_id: string | null;
          first_touch_at: string | null;
          first_touch_source: string | null;
          flow_waiting_reply: boolean | null;
          has_whatsapp: boolean | null;
          human_takeover_until: string | null;
          id: string;
          instagram_photo_url: string | null;
          instagram_url: string | null;
          is_suppressed: boolean;
          is_test: boolean | null;
          last_campaign_id: string | null;
          last_touch_at: string | null;
          last_touch_source: string | null;
          logo_url: string | null;
          maps_url: string | null;
          marketing_consent_at: string | null;
          marketing_consent_proof: Json;
          marketing_consent_source: string | null;
          marketing_consent_status: string;
          marketing_opt_out_reason: string | null;
          marketing_opted_out_at: string | null;
          name: string;
          notes: string | null;
          phone: string;
          phone_normalized: string | null;
          phone_valid: boolean | null;
          place_id: string | null;
          professional_photo_url: string | null;
          source: string | null;
          stage_id: string | null;
          structure_photo_url: string | null;
          suppressed_at: string | null;
          suppression_reason: string | null;
          tags: string[] | null;
          test_expires_at: string | null;
          top_reviews: Json | null;
          updated_at: string | null;
          user_id: string;
          website: string | null;
          whatsapp: string | null;
          workspace_id: string | null;
        };
        Insert: {
          about?: string | null;
          active_flow_id?: string | null;
          active_flow_step?: number | null;
          address?: string | null;
          all_photos?: Json | null;
          attribution?: Json;
          category?: string | null;
          company?: string | null;
          cover_photo_url?: string | null;
          created_at?: string | null;
          email?: string | null;
          enriched_at?: string | null;
          facade_photo_url?: string | null;
          first_campaign_id?: string | null;
          first_touch_at?: string | null;
          first_touch_source?: string | null;
          flow_waiting_reply?: boolean | null;
          has_whatsapp?: boolean | null;
          human_takeover_until?: string | null;
          id?: string;
          instagram_photo_url?: string | null;
          instagram_url?: string | null;
          is_suppressed?: boolean;
          is_test?: boolean | null;
          last_campaign_id?: string | null;
          last_touch_at?: string | null;
          last_touch_source?: string | null;
          logo_url?: string | null;
          maps_url?: string | null;
          marketing_consent_at?: string | null;
          marketing_consent_proof?: Json;
          marketing_consent_source?: string | null;
          marketing_consent_status?: string;
          marketing_opt_out_reason?: string | null;
          marketing_opted_out_at?: string | null;
          name: string;
          notes?: string | null;
          phone: string;
          phone_normalized?: string | null;
          phone_valid?: boolean | null;
          place_id?: string | null;
          professional_photo_url?: string | null;
          source?: string | null;
          stage_id?: string | null;
          structure_photo_url?: string | null;
          suppressed_at?: string | null;
          suppression_reason?: string | null;
          tags?: string[] | null;
          test_expires_at?: string | null;
          top_reviews?: Json | null;
          updated_at?: string | null;
          user_id: string;
          website?: string | null;
          whatsapp?: string | null;
          workspace_id?: string | null;
        };
        Update: {
          about?: string | null;
          active_flow_id?: string | null;
          active_flow_step?: number | null;
          address?: string | null;
          all_photos?: Json | null;
          attribution?: Json;
          category?: string | null;
          company?: string | null;
          cover_photo_url?: string | null;
          created_at?: string | null;
          email?: string | null;
          enriched_at?: string | null;
          facade_photo_url?: string | null;
          first_campaign_id?: string | null;
          first_touch_at?: string | null;
          first_touch_source?: string | null;
          flow_waiting_reply?: boolean | null;
          has_whatsapp?: boolean | null;
          human_takeover_until?: string | null;
          id?: string;
          instagram_photo_url?: string | null;
          instagram_url?: string | null;
          is_suppressed?: boolean;
          is_test?: boolean | null;
          last_campaign_id?: string | null;
          last_touch_at?: string | null;
          last_touch_source?: string | null;
          logo_url?: string | null;
          maps_url?: string | null;
          marketing_consent_at?: string | null;
          marketing_consent_proof?: Json;
          marketing_consent_source?: string | null;
          marketing_consent_status?: string;
          marketing_opt_out_reason?: string | null;
          marketing_opted_out_at?: string | null;
          name?: string;
          notes?: string | null;
          phone?: string;
          phone_normalized?: string | null;
          phone_valid?: boolean | null;
          place_id?: string | null;
          professional_photo_url?: string | null;
          source?: string | null;
          stage_id?: string | null;
          structure_photo_url?: string | null;
          suppressed_at?: string | null;
          suppression_reason?: string | null;
          tags?: string[] | null;
          test_expires_at?: string | null;
          top_reviews?: Json | null;
          updated_at?: string | null;
          user_id?: string;
          website?: string | null;
          whatsapp?: string | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "leads_first_campaign_id_fkey";
            columns: ["first_campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "leads_last_campaign_id_fkey";
            columns: ["last_campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "leads_stage_id_fkey";
            columns: ["stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "leads_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      lead_stage_events: {
        Row: {
          changed_by: string | null;
          created_at: string;
          event_type: string;
          from_stage_id: string | null;
          id: string;
          lead_id: string;
          metadata: Json;
          occurred_at: string;
          to_stage_id: string | null;
          user_id: string;
          workspace_id: string | null;
        };
        Insert: {
          changed_by?: string | null;
          created_at?: string;
          event_type: string;
          from_stage_id?: string | null;
          id?: string;
          lead_id: string;
          metadata?: Json;
          occurred_at?: string;
          to_stage_id?: string | null;
          user_id: string;
          workspace_id?: string | null;
        };
        Update: {
          changed_by?: string | null;
          created_at?: string;
          event_type?: string;
          from_stage_id?: string | null;
          id?: string;
          lead_id?: string;
          metadata?: Json;
          occurred_at?: string;
          to_stage_id?: string | null;
          user_id?: string;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "lead_stage_events_from_stage_id_fkey";
            columns: ["from_stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_stage_events_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_stage_events_to_stage_id_fkey";
            columns: ["to_stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_stage_events_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      logs: {
        Row: {
          block_id: string | null;
          created_at: string | null;
          details: Json | null;
          event: string;
          flow_id: string | null;
          id: string;
          lead_id: string | null;
          user_id: string;
        };
        Insert: {
          block_id?: string | null;
          created_at?: string | null;
          details?: Json | null;
          event: string;
          flow_id?: string | null;
          id?: string;
          lead_id?: string | null;
          user_id: string;
        };
        Update: {
          block_id?: string | null;
          created_at?: string | null;
          details?: Json | null;
          event?: string;
          flow_id?: string | null;
          id?: string;
          lead_id?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          block_id: string | null;
          content: string;
          created_at: string | null;
          direction: string;
          flow_id: string | null;
          id: string;
          lead_id: string;
          media_type: string | null;
          origin: string | null;
          queue_item_id: string | null;
          status: string | null;
          user_id: string;
          whatsapp_id: string | null;
        };
        Insert: {
          block_id?: string | null;
          content: string;
          created_at?: string | null;
          direction: string;
          flow_id?: string | null;
          id?: string;
          lead_id: string;
          media_type?: string | null;
          origin?: string | null;
          queue_item_id?: string | null;
          status?: string | null;
          user_id: string;
          whatsapp_id?: string | null;
        };
        Update: {
          block_id?: string | null;
          content?: string;
          created_at?: string | null;
          direction?: string;
          flow_id?: string | null;
          id?: string;
          lead_id?: string;
          media_type?: string | null;
          origin?: string | null;
          queue_item_id?: string | null;
          status?: string | null;
          user_id?: string;
          whatsapp_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "messages_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_queue_item_id_fkey";
            columns: ["queue_item_id"];
            isOneToOne: false;
            referencedRelation: "send_queue";
            referencedColumns: ["id"];
          },
        ];
      };
      objections: {
        Row: {
          content: string;
          created_at: string | null;
          id: string;
          lead_id: string;
          resolved: boolean | null;
          user_id: string;
        };
        Insert: {
          content: string;
          created_at?: string | null;
          id?: string;
          lead_id: string;
          resolved?: boolean | null;
          user_id: string;
        };
        Update: {
          content?: string;
          created_at?: string | null;
          id?: string;
          lead_id?: string;
          resolved?: boolean | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "objections_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
        ];
      };
      personal_tasks: {
        Row: {
          assignee_ref: string | null;
          assignee_type: string;
          completed_at: string | null;
          created_at: string;
          creator_ref: string | null;
          creator_type: string;
          description: string | null;
          due_date: string | null;
          external_order_id: string | null;
          id: string;
          idempotency_key: string | null;
          lead_id: string | null;
          origin: string;
          position: number;
          priority: string;
          project_ref: string | null;
          result: string | null;
          result_ref: string | null;
          status: string;
          title: string;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          assignee_ref?: string | null;
          assignee_type?: string;
          completed_at?: string | null;
          created_at?: string;
          creator_ref?: string | null;
          creator_type?: string;
          description?: string | null;
          due_date?: string | null;
          external_order_id?: string | null;
          id?: string;
          idempotency_key?: string | null;
          lead_id?: string | null;
          origin?: string;
          position?: number;
          priority?: string;
          project_ref?: string | null;
          result?: string | null;
          result_ref?: string | null;
          status?: string;
          title: string;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          assignee_ref?: string | null;
          assignee_type?: string;
          completed_at?: string | null;
          created_at?: string;
          creator_ref?: string | null;
          creator_type?: string;
          description?: string | null;
          due_date?: string | null;
          external_order_id?: string | null;
          id?: string;
          idempotency_key?: string | null;
          lead_id?: string | null;
          origin?: string;
          position?: number;
          priority?: string;
          project_ref?: string | null;
          result?: string | null;
          result_ref?: string | null;
          status?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "personal_tasks_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
        ];
      };
      pipeline_stages: {
        Row: {
          color: string | null;
          created_at: string | null;
          funnel_key: string | null;
          id: string;
          name: string;
          position: number | null;
          user_id: string;
        };
        Insert: {
          color?: string | null;
          created_at?: string | null;
          funnel_key?: string | null;
          id?: string;
          name: string;
          position?: number | null;
          user_id: string;
        };
        Update: {
          color?: string | null;
          created_at?: string | null;
          funnel_key?: string | null;
          id?: string;
          name?: string;
          position?: number | null;
          user_id?: string;
        };
        Relationships: [];
      };
      send_queue: {
        Row: {
          attempts: number | null;
          block_id: string | null;
          claim_token: string | null;
          content: string | null;
          created_at: string | null;
          flow_id: string | null;
          id: string;
          lead_id: string;
          scheduled_at: string | null;
          sending_at: string | null;
          sent_at: string | null;
          status: string | null;
          user_id: string;
        };
        Insert: {
          attempts?: number | null;
          block_id?: string | null;
          claim_token?: string | null;
          content?: string | null;
          created_at?: string | null;
          flow_id?: string | null;
          id?: string;
          lead_id: string;
          scheduled_at?: string | null;
          sending_at?: string | null;
          sent_at?: string | null;
          status?: string | null;
          user_id: string;
        };
        Update: {
          attempts?: number | null;
          block_id?: string | null;
          claim_token?: string | null;
          content?: string | null;
          created_at?: string | null;
          flow_id?: string | null;
          id?: string;
          lead_id?: string;
          scheduled_at?: string | null;
          sending_at?: string | null;
          sent_at?: string | null;
          status?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "send_queue_block_id_fkey";
            columns: ["block_id"];
            isOneToOne: false;
            referencedRelation: "flow_blocks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "send_queue_flow_id_fkey";
            columns: ["flow_id"];
            isOneToOne: false;
            referencedRelation: "flows";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "send_queue_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
        ];
      };
      touchpoints: {
        Row: {
          campaign_id: string | null;
          channel: string;
          created_at: string;
          external_id: string | null;
          id: string;
          lead_id: string;
          metadata: Json;
          occurred_at: string;
          touch_type: string;
          user_id: string;
          workspace_id: string | null;
        };
        Insert: {
          campaign_id?: string | null;
          channel: string;
          created_at?: string;
          external_id?: string | null;
          id?: string;
          lead_id: string;
          metadata?: Json;
          occurred_at?: string;
          touch_type: string;
          user_id: string;
          workspace_id?: string | null;
        };
        Update: {
          campaign_id?: string | null;
          channel?: string;
          created_at?: string;
          external_id?: string | null;
          id?: string;
          lead_id?: string;
          metadata?: Json;
          occurred_at?: string;
          touch_type?: string;
          user_id?: string;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "touchpoints_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "touchpoints_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "touchpoints_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      whatsapp_connections: {
        Row: {
          access_token_encrypted: string | null;
          coexistence_enabled: boolean;
          created_at: string;
          display_name: string | null;
          display_phone_number: string | null;
          id: string;
          instance_name: string | null;
          last_meta_inbound_test_at: string | null;
          last_meta_inbound_wamid: string | null;
          last_meta_outbound_status: string | null;
          last_meta_outbound_test_at: string | null;
          last_meta_outbound_wamid: string | null;
          last_sync_at: string | null;
          messaging_limit_tier: string | null;
          meta_business_id: string | null;
          phone_number_id: string | null;
          provider: string;
          quality_rating: string | null;
          status: string;
          tenant_id: string;
          token_expires_at: string | null;
          token_type: string | null;
          updated_at: string;
          waba_id: string | null;
          webhook_subscribed_at: string | null;
        };
        Insert: {
          access_token_encrypted?: string | null;
          coexistence_enabled?: boolean;
          created_at?: string;
          display_name?: string | null;
          display_phone_number?: string | null;
          id?: string;
          instance_name?: string | null;
          last_meta_inbound_test_at?: string | null;
          last_meta_inbound_wamid?: string | null;
          last_meta_outbound_status?: string | null;
          last_meta_outbound_test_at?: string | null;
          last_meta_outbound_wamid?: string | null;
          last_sync_at?: string | null;
          messaging_limit_tier?: string | null;
          meta_business_id?: string | null;
          phone_number_id?: string | null;
          provider?: string;
          quality_rating?: string | null;
          status?: string;
          tenant_id: string;
          token_expires_at?: string | null;
          token_type?: string | null;
          updated_at?: string;
          waba_id?: string | null;
          webhook_subscribed_at?: string | null;
        };
        Update: {
          access_token_encrypted?: string | null;
          coexistence_enabled?: boolean;
          created_at?: string;
          display_name?: string | null;
          display_phone_number?: string | null;
          id?: string;
          instance_name?: string | null;
          last_meta_inbound_test_at?: string | null;
          last_meta_inbound_wamid?: string | null;
          last_meta_outbound_status?: string | null;
          last_meta_outbound_test_at?: string | null;
          last_meta_outbound_wamid?: string | null;
          last_sync_at?: string | null;
          messaging_limit_tier?: string | null;
          meta_business_id?: string | null;
          phone_number_id?: string | null;
          provider?: string;
          quality_rating?: string | null;
          status?: string;
          tenant_id?: string;
          token_expires_at?: string | null;
          token_type?: string | null;
          updated_at?: string;
          waba_id?: string | null;
          webhook_subscribed_at?: string | null;
        };
        Relationships: [];
      };
      workspace_members: {
        Row: {
          created_at: string;
          role: string;
          user_id: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          role?: string;
          user_id: string;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          role?: string;
          user_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspaces: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          owner_id: string;
          settings: Json;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          owner_id: string;
          settings?: Json;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          owner_id?: string;
          settings?: Json;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      next_send_slot: {
        Args: { p_min_at?: string; p_user_id: string };
        Returns: string;
      };
      reschedule_pending_queue: { Args: { p_user_id: string }; Returns: number };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
