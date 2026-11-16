
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "audit_log": {
                  Row: {
                    "action": string,"actor_id": string | null,"after": Json | null,"at": string,"before": Json | null,"entity": string,"entity_id": string | null,"id": string,"organisation_id": string,"reason": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"after"?: Json | null,"at"?: string,"before"?: Json | null,"entity": string,"entity_id"?: string | null,"id"?: string,"organisation_id": string,"reason"?: string | null
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"after"?: Json | null,"at"?: string,"before"?: Json | null,"entity"?: string,"entity_id"?: string | null,"id"?: string,"organisation_id"?: string,"reason"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "audit_log_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"clients": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"name": string,"organisation_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"name": string,"organisation_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"name"?: string,"organisation_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "clients_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"departments": {
                  Row: {
                    "created_at": string,"created_by": string | null,"head_worker_id": string | null,"id": string,"name": string,"organisation_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"head_worker_id"?: string | null,"id"?: string,"name": string,"organisation_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"head_worker_id"?: string | null,"id"?: string,"name"?: string,"organisation_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "departments_head_worker_fkey"
      columns: ["organisation_id","head_worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "departments_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"membership_invites": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"created_at": string,"created_by": string | null,"email": string,"expires_at": string,"id": string,"organisation_id": string,"role": Database["public"]['Enums']["membership_role"],"token_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"email": string,"expires_at"?: string,"id"?: string,"organisation_id": string,"role": Database["public"]['Enums']["membership_role"],"token_hash": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"email"?: string,"expires_at"?: string,"id"?: string,"organisation_id"?: string,"role"?: Database["public"]['Enums']["membership_role"],"token_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "membership_invites_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"memberships": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"organisation_id": string,"role": Database["public"]['Enums']["membership_role"],"user_id": string,"worker_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"organisation_id": string,"role": Database["public"]['Enums']["membership_role"],"user_id": string,"worker_id"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"organisation_id"?: string,"role"?: Database["public"]['Enums']["membership_role"],"user_id"?: string,"worker_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "memberships_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "memberships_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"organisations": {
                  Row: {
                    "address": string | null,"auto_email_receipts": boolean,"company_code": string,"created_at": string,"created_by": string | null,"expected_workers": number | null,"head_office_state": string | null,"hourly_rate_divisor_days": number,"id": string,"industry": string | null,"invoice_email": string | null,"invoice_number_start": number,"legal_name": string | null,"logo_path": string | null,"name": string,"pay_cycle_start_day": number,"pay_day": number,"payment_terms_days": number,"phone": string | null,"plan": string,"rc_number": string | null,"setup_completed_at": string | null,"setup_step": number,"standard_shift_minutes": number,"timezone": string,"tin": string | null,"trading_name": string | null,"updated_at": string,"vat_registered": boolean,"work_days_per_week": number
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"auto_email_receipts"?: boolean,"company_code": string,"created_at"?: string,"created_by"?: string | null,"expected_workers"?: number | null,"head_office_state"?: string | null,"hourly_rate_divisor_days"?: number,"id"?: string,"industry"?: string | null,"invoice_email"?: string | null,"invoice_number_start"?: number,"legal_name"?: string | null,"logo_path"?: string | null,"name": string,"pay_cycle_start_day"?: number,"pay_day"?: number,"payment_terms_days"?: number,"phone"?: string | null,"plan"?: string,"rc_number"?: string | null,"setup_completed_at"?: string | null,"setup_step"?: number,"standard_shift_minutes"?: number,"timezone"?: string,"tin"?: string | null,"trading_name"?: string | null,"updated_at"?: string,"vat_registered"?: boolean,"work_days_per_week"?: number
                  }
                  Update: {
                    "address"?: string | null,"auto_email_receipts"?: boolean,"company_code"?: string,"created_at"?: string,"created_by"?: string | null,"expected_workers"?: number | null,"head_office_state"?: string | null,"hourly_rate_divisor_days"?: number,"id"?: string,"industry"?: string | null,"invoice_email"?: string | null,"invoice_number_start"?: number,"legal_name"?: string | null,"logo_path"?: string | null,"name"?: string,"pay_cycle_start_day"?: number,"pay_day"?: number,"payment_terms_days"?: number,"phone"?: string | null,"plan"?: string,"rc_number"?: string | null,"setup_completed_at"?: string | null,"setup_step"?: number,"standard_shift_minutes"?: number,"timezone"?: string,"tin"?: string | null,"trading_name"?: string | null,"updated_at"?: string,"vat_registered"?: boolean,"work_days_per_week"?: number
                  }
                  Relationships: [
                    
                  ]
                },"pay_rates": {
                  Row: {
                    "basic_kobo": number | null,"created_at": string,"created_by": string | null,"currency": string,"daily_rate_kobo": number | null,"effective_from": string,"effective_to": string | null,"hourly_rate_kobo": number | null,"housing_kobo": number | null,"id": string,"organisation_id": string,"other_allowances_kobo": number | null,"pay_type": Database["public"]['Enums']["pay_type"],"transport_kobo": number | null,"updated_at": string,"worker_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "basic_kobo"?: number | null,"created_at"?: string,"created_by"?: string | null,"currency"?: string,"daily_rate_kobo"?: number | null,"effective_from": string,"effective_to"?: string | null,"hourly_rate_kobo"?: number | null,"housing_kobo"?: number | null,"id"?: string,"organisation_id": string,"other_allowances_kobo"?: number | null,"pay_type": Database["public"]['Enums']["pay_type"],"transport_kobo"?: number | null,"updated_at"?: string,"worker_id": string
                  }
                  Update: {
                    "basic_kobo"?: number | null,"created_at"?: string,"created_by"?: string | null,"currency"?: string,"daily_rate_kobo"?: number | null,"effective_from"?: string,"effective_to"?: string | null,"hourly_rate_kobo"?: number | null,"housing_kobo"?: number | null,"id"?: string,"organisation_id"?: string,"other_allowances_kobo"?: number | null,"pay_type"?: Database["public"]['Enums']["pay_type"],"transport_kobo"?: number | null,"updated_at"?: string,"worker_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "pay_rates_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pay_rates_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"full_name": string | null,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"full_name"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"full_name"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"projects": {
                  Row: {
                    "client_id": string,"created_at": string,"created_by": string | null,"id": string,"name": string,"organisation_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "client_id": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"name": string,"organisation_id": string,"updated_at"?: string
                  }
                  Update: {
                    "client_id"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"name"?: string,"organisation_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "projects_client_fkey"
      columns: ["organisation_id","client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "projects_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"sites": {
                  Row: {
                    "client_id": string,"created_at": string,"created_by": string | null,"id": string,"name": string,"organisation_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "client_id": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"name": string,"organisation_id": string,"updated_at"?: string
                  }
                  Update: {
                    "client_id"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"name"?: string,"organisation_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sites_client_fkey"
      columns: ["organisation_id","client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "sites_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"worker_assignments": {
                  Row: {
                    "client_id": string | null,"created_at": string,"created_by": string | null,"effective_from": string,"effective_to": string | null,"id": string,"organisation_id": string,"project_id": string | null,"site_id": string | null,"updated_at": string,"worker_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "client_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"effective_from": string,"effective_to"?: string | null,"id"?: string,"organisation_id": string,"project_id"?: string | null,"site_id"?: string | null,"updated_at"?: string,"worker_id": string
                  }
                  Update: {
                    "client_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"effective_from"?: string,"effective_to"?: string | null,"id"?: string,"organisation_id"?: string,"project_id"?: string | null,"site_id"?: string | null,"updated_at"?: string,"worker_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "worker_assignments_client_fkey"
      columns: ["organisation_id","client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "worker_assignments_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "worker_assignments_project_fkey"
      columns: ["organisation_id","project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "worker_assignments_site_fkey"
      columns: ["organisation_id","site_id"]
isOneToOne: false
      referencedRelation: "sites"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "worker_assignments_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"worker_credentials": {
                  Row: {
                    "auth_user_id": string,"created_at": string,"failed_attempts": number,"id": string,"last_sign_in_at": string | null,"locked_until": string | null,"organisation_id": string,"pin_set_at": string,"privacy_notice_accepted_at": string,"updated_at": string,"worker_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "auth_user_id": string,"created_at"?: string,"failed_attempts"?: number,"id"?: string,"last_sign_in_at"?: string | null,"locked_until"?: string | null,"organisation_id": string,"pin_set_at"?: string,"privacy_notice_accepted_at": string,"updated_at"?: string,"worker_id": string
                  }
                  Update: {
                    "auth_user_id"?: string,"created_at"?: string,"failed_attempts"?: number,"id"?: string,"last_sign_in_at"?: string | null,"locked_until"?: string | null,"organisation_id"?: string,"pin_set_at"?: string,"privacy_notice_accepted_at"?: string,"updated_at"?: string,"worker_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "worker_credentials_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "worker_credentials_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"worker_invites": {
                  Row: {
                    "created_at": string,"created_by": string | null,"expires_at": string,"id": string,"organisation_id": string,"revoked_at": string | null,"sent_via": string,"token_hash": string,"used_at": string | null,"worker_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"expires_at"?: string,"id"?: string,"organisation_id": string,"revoked_at"?: string | null,"sent_via": string,"token_hash": string,"used_at"?: string | null,"worker_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"expires_at"?: string,"id"?: string,"organisation_id"?: string,"revoked_at"?: string | null,"sent_via"?: string,"token_hash"?: string,"used_at"?: string | null,"worker_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "worker_invites_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "worker_invites_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"workers": {
                  Row: {
                    "account_name": string | null,"annual_rent_declared_kobo": number | null,"bank_account_enc": string | null,"bank_account_last4": string | null,"bank_name": string | null,"created_at": string,"created_by": string | null,"currency": string,"department_id": string | null,"email": string | null,"employment_type": Database["public"]['Enums']["employment_type"],"end_date": string | null,"first_name": string,"id": string,"job_title": string | null,"last_name": string,"line_manager_membership_id": string | null,"line_manager_worker_id": string | null,"needs_pay_details": boolean,"next_of_kin_name": string | null,"next_of_kin_phone": string | null,"nhf_opt_in": boolean,"nin_enc": string | null,"organisation_id": string,"pfa_name": string | null,"phone": string | null,"rsa_pin_enc": string | null,"rsa_pin_last4": string | null,"staff_id": string,"start_date": string,"status": Database["public"]['Enums']["worker_status"],"supervisor_clock_in": boolean,"tax_state": string | null,"tin": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_name"?: string | null,"annual_rent_declared_kobo"?: number | null,"bank_account_enc"?: string | null,"bank_account_last4"?: string | null,"bank_name"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency"?: string,"department_id"?: string | null,"email"?: string | null,"employment_type": Database["public"]['Enums']["employment_type"],"end_date"?: string | null,"first_name": string,"id"?: string,"job_title"?: string | null,"last_name": string,"line_manager_membership_id"?: string | null,"line_manager_worker_id"?: string | null,"needs_pay_details"?: boolean,"next_of_kin_name"?: string | null,"next_of_kin_phone"?: string | null,"nhf_opt_in"?: boolean,"nin_enc"?: string | null,"organisation_id": string,"pfa_name"?: string | null,"phone"?: string | null,"rsa_pin_enc"?: string | null,"rsa_pin_last4"?: string | null,"staff_id": string,"start_date": string,"status"?: Database["public"]['Enums']["worker_status"],"supervisor_clock_in"?: boolean,"tax_state"?: string | null,"tin"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "account_name"?: string | null,"annual_rent_declared_kobo"?: number | null,"bank_account_enc"?: string | null,"bank_account_last4"?: string | null,"bank_name"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency"?: string,"department_id"?: string | null,"email"?: string | null,"employment_type"?: Database["public"]['Enums']["employment_type"],"end_date"?: string | null,"first_name"?: string,"id"?: string,"job_title"?: string | null,"last_name"?: string,"line_manager_membership_id"?: string | null,"line_manager_worker_id"?: string | null,"needs_pay_details"?: boolean,"next_of_kin_name"?: string | null,"next_of_kin_phone"?: string | null,"nhf_opt_in"?: boolean,"nin_enc"?: string | null,"organisation_id"?: string,"pfa_name"?: string | null,"phone"?: string | null,"rsa_pin_enc"?: string | null,"rsa_pin_last4"?: string | null,"staff_id"?: string,"start_date"?: string,"status"?: Database["public"]['Enums']["worker_status"],"supervisor_clock_in"?: boolean,"tax_state"?: string | null,"tin"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "workers_department_fkey"
      columns: ["organisation_id","department_id"]
isOneToOne: false
      referencedRelation: "departments"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "workers_line_manager_membership_fkey"
      columns: ["organisation_id","line_manager_membership_id"]
isOneToOne: false
      referencedRelation: "memberships"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "workers_line_manager_worker_fkey"
      columns: ["organisation_id","line_manager_worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "workers_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_membership_invite":
{ Args: { "p_token": string }; Returns: string
                           },
"accept_worker_invite":
{ Args: { "p_auth_user_id": string,"p_pin_hash": string,"p_token": string }; Returns: {
              "organisation_id": string,"pin_reset": boolean,"worker_id": string
            }[]
                           },
"add_pay_rate":
{ Args: { "p_organisation_id": string,"p_rate": Json,"p_worker_id": string }; Returns: string
                           },
"cancel_pay_rate":
{ Args: { "p_organisation_id": string,"p_pay_rate_id": string }; Returns: undefined
                           },
"choose_company_plan":
{ Args: { "p_expected_workers": number,"p_organisation_id": string,"p_plan": string }; Returns: undefined
                           },
"complete_company_setup":
{ Args: { "p_organisation_id": string }; Returns: string
                           },
"create_first_organisation":
{ Args: { "p_name": string }; Returns: string
                           },
"create_membership_invite":
{ Args: { "p_email": string,"p_organisation_id": string,"p_role": Database["public"]['Enums']["membership_role"] }; Returns: string
                           },
"create_organisation":
{ Args: { "p_name": string }; Returns: string
                           },
"create_worker":
{ Args: { "p_pay_rate"?: Json,"p_worker": Json }; Returns: string
                           },
"create_worker_invites":
{ Args: { "p_organisation_id": string,"p_sent_via": string,"p_worker_ids": (string)[] }; Returns: {
              "invite_expires_at": string,"invite_id": string,"invite_worker_id": string,"token": string
            }[]
                           },
"end_employment":
{ Args: { "p_end_date": string,"p_organisation_id": string,"p_worker_id": string }; Returns: undefined
                           },
"log_audit":
{ Args: { "p_action": string,"p_after"?: Json,"p_before"?: Json,"p_entity": string,"p_entity_id"?: string,"p_organisation_id": string,"p_reason"?: string }; Returns: string
                           },
"worker_invite_lookup":
{ Args: { "p_token": string }; Returns: {
              "auth_user_id": string,"company_code": string,"first_name": string,"invite_id": string,"last_name": string,"organisation_id": string,"organisation_name": string,"staff_id": string,"state": string,"worker_id": string
            }[]
                           },
"worker_sign_in_begin":
{ Args: { "p_company_code": string,"p_ip_key": string,"p_staff_id": string }; Returns: {
              "auth_user_id": string,"locks_on_failure": boolean,"organisation_id": string,"outcome": string,"pin_hash": string,"worker_id": string
            }[]
                           },
"worker_sign_in_finish":
{ Args: { "p_ip_key": string,"p_ok": boolean,"p_worker_id": string }; Returns: string
                           }
          }
          Enums: {
            "employment_type": "permanent"|"contract"|"casual"|"daily","membership_role": "owner"|"admin"|"hr"|"finance"|"ops_manager"|"line_manager"|"worker"|"client_approver","pay_type": "monthly"|"daily"|"hourly","worker_status": "active"|"ended"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "employment_type": ["permanent", "contract", "casual", "daily"],"membership_role": ["owner", "admin", "hr", "finance", "ops_manager", "line_manager", "worker", "client_approver"],"pay_type": ["monthly", "daily", "hourly"],"worker_status": ["active", "ended"]
          }
        }
} as const
