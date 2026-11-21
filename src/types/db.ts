
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "audit_log": {
                  Row: {
                    "action": string,"actor_id": string | null,"after": Json | null,"at": string,"before": Json | null,"channel": string,"entity": string,"entity_id": string | null,"id": string,"organisation_id": string,"reason": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"after"?: Json | null,"at"?: string,"before"?: Json | null,"channel"?: string,"entity": string,"entity_id"?: string | null,"id"?: string,"organisation_id": string,"reason"?: string | null
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"after"?: Json | null,"at"?: string,"before"?: Json | null,"channel"?: string,"entity"?: string,"entity_id"?: string | null,"id"?: string,"organisation_id"?: string,"reason"?: string | null
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
                },"bank_account_lookups": {
                  Row: {
                    "account_name": string | null,"bank_account_digest": string,"bank_account_last4": string,"bank_code": string,"client_ip": string | null,"created_at": string,"finished_at": string | null,"id": string,"organisation_id": string,"purpose": Database["public"]['Enums']["bank_lookup_purpose"],"requested_by": string,"source": string | null,"status": Database["public"]['Enums']["bank_lookup_status"],"used_at": string | null,"worker_enc_md5": string | null,"worker_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "account_name"?: string | null,"bank_account_digest": string,"bank_account_last4": string,"bank_code": string,"client_ip"?: string | null,"created_at"?: string,"finished_at"?: string | null,"id"?: string,"organisation_id": string,"purpose": Database["public"]['Enums']["bank_lookup_purpose"],"requested_by": string,"source"?: string | null,"status"?: Database["public"]['Enums']["bank_lookup_status"],"used_at"?: string | null,"worker_enc_md5"?: string | null,"worker_id"?: string | null
                  }
                  Update: {
                    "account_name"?: string | null,"bank_account_digest"?: string,"bank_account_last4"?: string,"bank_code"?: string,"client_ip"?: string | null,"created_at"?: string,"finished_at"?: string | null,"id"?: string,"organisation_id"?: string,"purpose"?: Database["public"]['Enums']["bank_lookup_purpose"],"requested_by"?: string,"source"?: string | null,"status"?: Database["public"]['Enums']["bank_lookup_status"],"used_at"?: string | null,"worker_enc_md5"?: string | null,"worker_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "bank_account_lookups_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "bank_account_lookups_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"bank_detail_changes": {
                  Row: {
                    "account_name": string,"applied_at": string | null,"applied_notified_at": string | null,"applies_after": string | null,"approved_by": string | null,"bank_account_digest": string | null,"bank_account_enc": string,"bank_account_last4": string,"bank_code": string | null,"bank_lookup_id": string | null,"bank_name": string,"cancelled_at": string | null,"cancelled_by": string | null,"created_at": string,"decided_at": string | null,"decision_note": string | null,"id": string,"name_check": Database["public"]['Enums']["bank_name_check"] | null,"name_check_expected": string | null,"name_check_reason": string | null,"name_check_source": string | null,"organisation_id": string,"previous_account_name": string | null,"previous_bank_account_enc": string | null,"previous_bank_account_last4": string | null,"previous_bank_name": string | null,"raised_by_worker": boolean,"reason": string | null,"rejected_by": string | null,"requested_by": string,"status": Database["public"]['Enums']["bank_detail_change_status"],"updated_at": string,"worker_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_name": string,"applied_at"?: string | null,"applied_notified_at"?: string | null,"applies_after"?: string | null,"approved_by"?: string | null,"bank_account_digest"?: string | null,"bank_account_enc": string,"bank_account_last4": string,"bank_code"?: string | null,"bank_lookup_id"?: string | null,"bank_name": string,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"created_at"?: string,"decided_at"?: string | null,"decision_note"?: string | null,"id"?: string,"name_check"?: Database["public"]['Enums']["bank_name_check"] | null,"name_check_expected"?: string | null,"name_check_reason"?: string | null,"name_check_source"?: string | null,"organisation_id": string,"previous_account_name"?: string | null,"previous_bank_account_enc"?: string | null,"previous_bank_account_last4"?: string | null,"previous_bank_name"?: string | null,"raised_by_worker"?: boolean,"reason"?: string | null,"rejected_by"?: string | null,"requested_by"?: string,"status"?: Database["public"]['Enums']["bank_detail_change_status"],"updated_at"?: string,"worker_id": string
                  }
                  Update: {
                    "account_name"?: string,"applied_at"?: string | null,"applied_notified_at"?: string | null,"applies_after"?: string | null,"approved_by"?: string | null,"bank_account_digest"?: string | null,"bank_account_enc"?: string,"bank_account_last4"?: string,"bank_code"?: string | null,"bank_lookup_id"?: string | null,"bank_name"?: string,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"created_at"?: string,"decided_at"?: string | null,"decision_note"?: string | null,"id"?: string,"name_check"?: Database["public"]['Enums']["bank_name_check"] | null,"name_check_expected"?: string | null,"name_check_reason"?: string | null,"name_check_source"?: string | null,"organisation_id"?: string,"previous_account_name"?: string | null,"previous_bank_account_enc"?: string | null,"previous_bank_account_last4"?: string | null,"previous_bank_name"?: string | null,"raised_by_worker"?: boolean,"reason"?: string | null,"rejected_by"?: string | null,"requested_by"?: string,"status"?: Database["public"]['Enums']["bank_detail_change_status"],"updated_at"?: string,"worker_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "bank_detail_changes_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "bank_detail_changes_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"client_contacts": {
                  Row: {
                    "client_id": string,"created_at": string,"created_by": string | null,"email": string,"id": string,"is_primary": boolean,"name": string,"organisation_id": string,"phone": string | null,"role": string,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "client_id": string,"created_at"?: string,"created_by"?: string | null,"email": string,"id"?: string,"is_primary"?: boolean,"name": string,"organisation_id": string,"phone"?: string | null,"role": string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "client_id"?: string,"created_at"?: string,"created_by"?: string | null,"email"?: string,"id"?: string,"is_primary"?: boolean,"name"?: string,"organisation_id"?: string,"phone"?: string | null,"role"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "client_contacts_client_fkey"
      columns: ["organisation_id","client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "client_contacts_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"clients": {
                  Row: {
                    "billing_address": string | null,"billing_terms_days": number | null,"created_at": string,"created_by": string | null,"deducts_wht": string,"id": string,"legal_name": string | null,"name": string,"notes": string | null,"organisation_id": string,"rc_number": string | null,"state": string | null,"status": string,"tin": string | null,"updated_at": string,"withholds_vat": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "billing_address"?: string | null,"billing_terms_days"?: number | null,"created_at"?: string,"created_by"?: string | null,"deducts_wht"?: string,"id"?: string,"legal_name"?: string | null,"name": string,"notes"?: string | null,"organisation_id": string,"rc_number"?: string | null,"state"?: string | null,"status"?: string,"tin"?: string | null,"updated_at"?: string,"withholds_vat"?: boolean
                  }
                  Update: {
                    "billing_address"?: string | null,"billing_terms_days"?: number | null,"created_at"?: string,"created_by"?: string | null,"deducts_wht"?: string,"id"?: string,"legal_name"?: string | null,"name"?: string,"notes"?: string | null,"organisation_id"?: string,"rc_number"?: string | null,"state"?: string | null,"status"?: string,"tin"?: string | null,"updated_at"?: string,"withholds_vat"?: boolean
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
                },"contract_changes": {
                  Row: {
                    "contract_id": string,"created_at": string,"created_by": string | null,"detail": NonNullable<Json>,"effective_on": string,"id": string,"kind": string,"organisation_id": string,"post_id": string | null,"reason": string | null,"site_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "contract_id": string,"created_at"?: string,"created_by"?: string | null,"detail"?: NonNullable<Json>,"effective_on": string,"id"?: string,"kind": string,"organisation_id": string,"post_id"?: string | null,"reason"?: string | null,"site_id"?: string | null
                  }
                  Update: {
                    "contract_id"?: string,"created_at"?: string,"created_by"?: string | null,"detail"?: NonNullable<Json>,"effective_on"?: string,"id"?: string,"kind"?: string,"organisation_id"?: string,"post_id"?: string | null,"reason"?: string | null,"site_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "contract_changes_contract_fkey"
      columns: ["organisation_id","contract_id"]
isOneToOne: false
      referencedRelation: "contracts"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "contract_changes_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "contract_changes_post_fkey"
      columns: ["organisation_id","post_id"]
isOneToOne: false
      referencedRelation: "posts"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "contract_changes_site_fkey"
      columns: ["organisation_id","site_id"]
isOneToOne: false
      referencedRelation: "sites"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"contract_documents": {
                  Row: {
                    "contract_id": string,"created_at": string,"file_deleted_at": string | null,"file_ext": string,"file_name": string,"id": string,"kind": string,"mime_type": string,"organisation_id": string,"removed_at": string | null,"removed_by": string | null,"removed_reason": string | null,"sha256": string | null,"size_bytes": number | null,"status": string,"storage_path": string,"title": string,"updated_at": string,"uploaded_at": string | null,"uploaded_by": string
                  }
                  ComputedFields: never
                  Insert: {
                    "contract_id": string,"created_at"?: string,"file_deleted_at"?: string | null,"file_ext": string,"file_name": string,"id"?: string,"kind": string,"mime_type": string,"organisation_id": string,"removed_at"?: string | null,"removed_by"?: string | null,"removed_reason"?: string | null,"sha256"?: string | null,"size_bytes"?: number | null,"status"?: string,"storage_path"?: string,"title": string,"updated_at"?: string,"uploaded_at"?: string | null,"uploaded_by"?: string
                  }
                  Update: {
                    "contract_id"?: string,"created_at"?: string,"file_deleted_at"?: string | null,"file_ext"?: string,"file_name"?: string,"id"?: string,"kind"?: string,"mime_type"?: string,"organisation_id"?: string,"removed_at"?: string | null,"removed_by"?: string | null,"removed_reason"?: string | null,"sha256"?: string | null,"size_bytes"?: number | null,"status"?: string,"storage_path"?: string,"title"?: string,"updated_at"?: string,"uploaded_at"?: string | null,"uploaded_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "contract_documents_contract_fkey"
      columns: ["organisation_id","contract_id"]
isOneToOne: false
      referencedRelation: "contracts"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "contract_documents_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"contract_sites": {
                  Row: {
                    "contract_id": string,"created_at": string,"created_by": string | null,"id": string,"organisation_id": string,"site_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "contract_id": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"organisation_id": string,"site_id": string
                  }
                  Update: {
                    "contract_id"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"organisation_id"?: string,"site_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "contract_sites_contract_fkey"
      columns: ["organisation_id","contract_id"]
isOneToOne: false
      referencedRelation: "contracts"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "contract_sites_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "contract_sites_site_fkey"
      columns: ["organisation_id","site_id"]
isOneToOne: false
      referencedRelation: "sites"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"contracts": {
                  Row: {
                    "activated_at": string | null,"activated_by": string | null,"billing_frequency": string,"billing_terms_days": number | null,"client_id": string,"created_at": string,"created_by": string | null,"end_date": string | null,"end_reason": string | null,"ended_at": string | null,"go_live_date": string | null,"id": string,"name": string,"organisation_id": string,"reference": string,"sla": NonNullable<Json>,"start_date": string,"status": string,"type": string,"updated_at": string,"vat_applies": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "activated_at"?: string | null,"activated_by"?: string | null,"billing_frequency"?: string,"billing_terms_days"?: number | null,"client_id": string,"created_at"?: string,"created_by"?: string | null,"end_date"?: string | null,"end_reason"?: string | null,"ended_at"?: string | null,"go_live_date"?: string | null,"id"?: string,"name": string,"organisation_id": string,"reference": string,"sla"?: NonNullable<Json>,"start_date": string,"status"?: string,"type": string,"updated_at"?: string,"vat_applies": boolean
                  }
                  Update: {
                    "activated_at"?: string | null,"activated_by"?: string | null,"billing_frequency"?: string,"billing_terms_days"?: number | null,"client_id"?: string,"created_at"?: string,"created_by"?: string | null,"end_date"?: string | null,"end_reason"?: string | null,"ended_at"?: string | null,"go_live_date"?: string | null,"id"?: string,"name"?: string,"organisation_id"?: string,"reference"?: string,"sla"?: NonNullable<Json>,"start_date"?: string,"status"?: string,"type"?: string,"updated_at"?: string,"vat_applies"?: boolean
                  }
                  Relationships: [
                    {
      foreignKeyName: "contracts_client_fkey"
      columns: ["organisation_id","client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "contracts_organisation_id_fkey"
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
                },"headcount_requirements": {
                  Row: {
                    "band": string,"contract_id": string,"created_at": string,"created_by": string | null,"days_of_week": (number)[],"duration_minutes": number | null,"end_time": string,"id": string,"kind": string | null,"notes": string | null,"organisation_id": string,"post_name": string | null,"required_count": number,"role": string,"site_id": string,"start_time": string,"unit": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "band"?: string,"contract_id": string,"created_at"?: string,"created_by"?: string | null,"days_of_week": (number)[],"duration_minutes"?: never,"end_time": string,"id"?: string,"kind"?: never,"notes"?: string | null,"organisation_id": string,"post_name"?: string | null,"required_count": number,"role": string,"site_id": string,"start_time": string,"unit": string,"updated_at"?: string
                  }
                  Update: {
                    "band"?: string,"contract_id"?: string,"created_at"?: string,"created_by"?: string | null,"days_of_week"?: (number)[],"duration_minutes"?: never,"end_time"?: string,"id"?: string,"kind"?: never,"notes"?: string | null,"organisation_id"?: string,"post_name"?: string | null,"required_count"?: number,"role"?: string,"site_id"?: string,"start_time"?: string,"unit"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "headcount_requirements_contract_fkey"
      columns: ["organisation_id","contract_id"]
isOneToOne: false
      referencedRelation: "contracts"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "headcount_requirements_contract_site_fkey"
      columns: ["organisation_id","contract_id","site_id"]
isOneToOne: false
      referencedRelation: "contract_sites"
      referencedColumns: ["organisation_id","contract_id","site_id"]
    },{
      foreignKeyName: "headcount_requirements_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"import_batches": {
                  Row: {
                    "cancelled_at": string | null,"columns": (string)[],"committed_at": string | null,"committed_by": string | null,"created_at": string,"created_by": string | null,"file_format": string,"file_name": string,"file_notes": NonNullable<Json>,"file_path": string,"file_problems": NonNullable<Json>,"file_removed_at": string | null,"id": string,"organisation_id": string,"rows_held": number,"rows_imported": number,"rows_ready": number,"rows_total": number,"status": Database["public"]['Enums']["import_batch_status"],"summary": Json | null,"updated_at": string,"validated_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "cancelled_at"?: string | null,"columns"?: (string)[],"committed_at"?: string | null,"committed_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"file_format": string,"file_name": string,"file_notes"?: NonNullable<Json>,"file_path": string,"file_problems"?: NonNullable<Json>,"file_removed_at"?: string | null,"id"?: string,"organisation_id": string,"rows_held"?: number,"rows_imported"?: number,"rows_ready"?: number,"rows_total"?: number,"status"?: Database["public"]['Enums']["import_batch_status"],"summary"?: Json | null,"updated_at"?: string,"validated_at"?: string | null
                  }
                  Update: {
                    "cancelled_at"?: string | null,"columns"?: (string)[],"committed_at"?: string | null,"committed_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"file_format"?: string,"file_name"?: string,"file_notes"?: NonNullable<Json>,"file_path"?: string,"file_problems"?: NonNullable<Json>,"file_removed_at"?: string | null,"id"?: string,"organisation_id"?: string,"rows_held"?: number,"rows_imported"?: number,"rows_ready"?: number,"rows_total"?: number,"status"?: Database["public"]['Enums']["import_batch_status"],"summary"?: Json | null,"updated_at"?: string,"validated_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_batches_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"import_rows": {
                  Row: {
                    "attention": boolean,"bank_account_enc": string | null,"batch_id": string,"created_at": string,"errors": NonNullable<Json>,"extra_values": number,"fixes": NonNullable<Json>,"id": string,"imported_at": string | null,"nin_enc": string | null,"normalised": Json | null,"numeric_columns": (string)[],"organisation_id": string,"raw": NonNullable<Json>,"row_number": number,"rsa_pin_enc": string | null,"status": Database["public"]['Enums']["import_row_status"],"updated_at": string,"warnings": NonNullable<Json>,"worker_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attention"?: boolean,"bank_account_enc"?: string | null,"batch_id": string,"created_at"?: string,"errors"?: NonNullable<Json>,"extra_values"?: number,"fixes"?: NonNullable<Json>,"id"?: string,"imported_at"?: string | null,"nin_enc"?: string | null,"normalised"?: Json | null,"numeric_columns"?: (string)[],"organisation_id": string,"raw": NonNullable<Json>,"row_number": number,"rsa_pin_enc"?: string | null,"status": Database["public"]['Enums']["import_row_status"],"updated_at"?: string,"warnings"?: NonNullable<Json>,"worker_id"?: string | null
                  }
                  Update: {
                    "attention"?: boolean,"bank_account_enc"?: string | null,"batch_id"?: string,"created_at"?: string,"errors"?: NonNullable<Json>,"extra_values"?: number,"fixes"?: NonNullable<Json>,"id"?: string,"imported_at"?: string | null,"nin_enc"?: string | null,"normalised"?: Json | null,"numeric_columns"?: (string)[],"organisation_id"?: string,"raw"?: NonNullable<Json>,"row_number"?: number,"rsa_pin_enc"?: string | null,"status"?: Database["public"]['Enums']["import_row_status"],"updated_at"?: string,"warnings"?: NonNullable<Json>,"worker_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_rows_batch_fkey"
      columns: ["organisation_id","batch_id"]
isOneToOne: false
      referencedRelation: "import_batches"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "import_rows_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "import_rows_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"inbox_items": {
                  Row: {
                    "body": string,"created_at": string,"emailed_at": string | null,"id": string,"kind": string,"link_path": string | null,"organisation_id": string,"read_at": string | null,"roster_publication_id": string | null,"title": string,"worker_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body": string,"created_at"?: string,"emailed_at"?: string | null,"id"?: string,"kind": string,"link_path"?: string | null,"organisation_id": string,"read_at"?: string | null,"roster_publication_id"?: string | null,"title": string,"worker_id": string
                  }
                  Update: {
                    "body"?: string,"created_at"?: string,"emailed_at"?: string | null,"id"?: string,"kind"?: string,"link_path"?: string | null,"organisation_id"?: string,"read_at"?: string | null,"roster_publication_id"?: string | null,"title"?: string,"worker_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "inbox_items_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "inbox_items_roster_publication_fkey"
      columns: ["organisation_id","roster_publication_id"]
isOneToOne: false
      referencedRelation: "roster_publications"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "inbox_items_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"membership_invites": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"created_at": string,"created_by": string | null,"email": string,"expires_at": string,"id": string,"organisation_id": string,"owner_change_id": string | null,"revoked_at": string | null,"revoked_by": string | null,"role": Database["public"]['Enums']["membership_role"],"sent_at": string,"token_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"email": string,"expires_at"?: string,"id"?: string,"organisation_id": string,"owner_change_id"?: string | null,"revoked_at"?: string | null,"revoked_by"?: string | null,"role": Database["public"]['Enums']["membership_role"],"sent_at"?: string,"token_hash": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"email"?: string,"expires_at"?: string,"id"?: string,"organisation_id"?: string,"owner_change_id"?: string | null,"revoked_at"?: string | null,"revoked_by"?: string | null,"role"?: Database["public"]['Enums']["membership_role"],"sent_at"?: string,"token_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "membership_invites_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "membership_invites_owner_change_id_fkey"
      columns: ["owner_change_id"]
isOneToOne: false
      referencedRelation: "owner_changes"
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
                },"organisation_bank_accounts": {
                  Row: {
                    "account_name": string,"activated_at": string | null,"applied_notified_at": string | null,"applies_after": string | null,"approved_by": string | null,"approved_notified_at": string | null,"bank_account_digest": string | null,"bank_account_enc": string,"bank_account_last4": string,"bank_code": string | null,"bank_lookup_id": string | null,"bank_name": string,"cancelled_at": string | null,"cancelled_by": string | null,"created_at": string,"decided_at": string | null,"decision_note": string | null,"id": string,"name_check": Database["public"]['Enums']["bank_name_check"] | null,"name_check_expected": string | null,"name_check_reason": string | null,"name_check_source": string | null,"organisation_id": string,"reason": string | null,"rejected_by": string | null,"requested_by": string,"requested_notified_at": string | null,"retired_at": string | null,"single_approver": boolean,"status": Database["public"]['Enums']["org_bank_account_status"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_name": string,"activated_at"?: string | null,"applied_notified_at"?: string | null,"applies_after"?: string | null,"approved_by"?: string | null,"approved_notified_at"?: string | null,"bank_account_digest"?: string | null,"bank_account_enc": string,"bank_account_last4": string,"bank_code"?: string | null,"bank_lookup_id"?: string | null,"bank_name": string,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"created_at"?: string,"decided_at"?: string | null,"decision_note"?: string | null,"id"?: string,"name_check"?: Database["public"]['Enums']["bank_name_check"] | null,"name_check_expected"?: string | null,"name_check_reason"?: string | null,"name_check_source"?: string | null,"organisation_id": string,"reason"?: string | null,"rejected_by"?: string | null,"requested_by"?: string,"requested_notified_at"?: string | null,"retired_at"?: string | null,"single_approver"?: boolean,"status"?: Database["public"]['Enums']["org_bank_account_status"],"updated_at"?: string
                  }
                  Update: {
                    "account_name"?: string,"activated_at"?: string | null,"applied_notified_at"?: string | null,"applies_after"?: string | null,"approved_by"?: string | null,"approved_notified_at"?: string | null,"bank_account_digest"?: string | null,"bank_account_enc"?: string,"bank_account_last4"?: string,"bank_code"?: string | null,"bank_lookup_id"?: string | null,"bank_name"?: string,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"created_at"?: string,"decided_at"?: string | null,"decision_note"?: string | null,"id"?: string,"name_check"?: Database["public"]['Enums']["bank_name_check"] | null,"name_check_expected"?: string | null,"name_check_reason"?: string | null,"name_check_source"?: string | null,"organisation_id"?: string,"reason"?: string | null,"rejected_by"?: string | null,"requested_by"?: string,"requested_notified_at"?: string | null,"retired_at"?: string | null,"single_approver"?: boolean,"status"?: Database["public"]['Enums']["org_bank_account_status"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organisation_bank_accounts_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"organisations": {
                  Row: {
                    "address": string | null,"auto_email_receipts": boolean,"business_type": string,"company_code": string,"created_at": string,"created_by": string | null,"expected_workers": number | null,"head_office_state": string | null,"hourly_rate_divisor_days": number,"id": string,"industry": string | null,"invoice_email": string | null,"invoice_number_start": number,"late_grace_minutes": number,"legal_name": string | null,"logo_path": string | null,"name": string,"no_show_after_minutes": number,"pay_cycle_start_day": number,"pay_day": number,"payment_terms_days": number,"payroll_enabled": boolean,"people_enabled": boolean,"phone": string | null,"plan": string,"rc_number": string | null,"setup_completed_at": string | null,"setup_step": number,"shifts_enabled": boolean,"standard_shift_minutes": number,"timezone": string,"tin": string | null,"trading_name": string | null,"updated_at": string,"vat_registered": boolean,"work_days_per_week": number
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"auto_email_receipts"?: boolean,"business_type"?: string,"company_code": string,"created_at"?: string,"created_by"?: string | null,"expected_workers"?: number | null,"head_office_state"?: string | null,"hourly_rate_divisor_days"?: number,"id"?: string,"industry"?: string | null,"invoice_email"?: string | null,"invoice_number_start"?: number,"late_grace_minutes"?: number,"legal_name"?: string | null,"logo_path"?: string | null,"name": string,"no_show_after_minutes"?: number,"pay_cycle_start_day"?: number,"pay_day"?: number,"payment_terms_days"?: number,"payroll_enabled"?: boolean,"people_enabled"?: boolean,"phone"?: string | null,"plan"?: string,"rc_number"?: string | null,"setup_completed_at"?: string | null,"setup_step"?: number,"shifts_enabled"?: boolean,"standard_shift_minutes"?: number,"timezone"?: string,"tin"?: string | null,"trading_name"?: string | null,"updated_at"?: string,"vat_registered"?: boolean,"work_days_per_week"?: number
                  }
                  Update: {
                    "address"?: string | null,"auto_email_receipts"?: boolean,"business_type"?: string,"company_code"?: string,"created_at"?: string,"created_by"?: string | null,"expected_workers"?: number | null,"head_office_state"?: string | null,"hourly_rate_divisor_days"?: number,"id"?: string,"industry"?: string | null,"invoice_email"?: string | null,"invoice_number_start"?: number,"late_grace_minutes"?: number,"legal_name"?: string | null,"logo_path"?: string | null,"name"?: string,"no_show_after_minutes"?: number,"pay_cycle_start_day"?: number,"pay_day"?: number,"payment_terms_days"?: number,"payroll_enabled"?: boolean,"people_enabled"?: boolean,"phone"?: string | null,"plan"?: string,"rc_number"?: string | null,"setup_completed_at"?: string | null,"setup_step"?: number,"shifts_enabled"?: boolean,"standard_shift_minutes"?: number,"timezone"?: string,"tin"?: string | null,"trading_name"?: string | null,"updated_at"?: string,"vat_registered"?: boolean,"work_days_per_week"?: number
                  }
                  Relationships: [
                    
                  ]
                },"owner_changes": {
                  Row: {
                    "approved_by": string | null,"cancel_reason": string | null,"cancelled_by": string | null,"created_at": string,"decided_at": string | null,"id": string,"invite_email": string | null,"kind": Database["public"]['Enums']["owner_change_kind"],"new_role": Database["public"]['Enums']["membership_role"] | null,"organisation_id": string,"owners_at_request": number,"reason": string | null,"rejected_by": string | null,"requested_by": string,"single_owner": boolean,"status": Database["public"]['Enums']["owner_change_status"],"target_membership_id": string | null,"target_user_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "approved_by"?: string | null,"cancel_reason"?: string | null,"cancelled_by"?: string | null,"created_at"?: string,"decided_at"?: string | null,"id"?: string,"invite_email"?: string | null,"kind": Database["public"]['Enums']["owner_change_kind"],"new_role"?: Database["public"]['Enums']["membership_role"] | null,"organisation_id": string,"owners_at_request": number,"reason"?: string | null,"rejected_by"?: string | null,"requested_by"?: string,"single_owner"?: boolean,"status"?: Database["public"]['Enums']["owner_change_status"],"target_membership_id"?: string | null,"target_user_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "approved_by"?: string | null,"cancel_reason"?: string | null,"cancelled_by"?: string | null,"created_at"?: string,"decided_at"?: string | null,"id"?: string,"invite_email"?: string | null,"kind"?: Database["public"]['Enums']["owner_change_kind"],"new_role"?: Database["public"]['Enums']["membership_role"] | null,"organisation_id"?: string,"owners_at_request"?: number,"reason"?: string | null,"rejected_by"?: string | null,"requested_by"?: string,"single_owner"?: boolean,"status"?: Database["public"]['Enums']["owner_change_status"],"target_membership_id"?: string | null,"target_user_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "owner_changes_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
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
                },"posts": {
                  Row: {
                    "band": string,"closed_on": string | null,"closed_reason": string | null,"contract_id": string,"created_at": string,"created_by": string | null,"headcount_requirement_id": string | null,"id": string,"kind": string | null,"name": string,"opened_on": string,"organisation_id": string,"role": string,"site_id": string,"status": string,"unit": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "band"?: string,"closed_on"?: string | null,"closed_reason"?: string | null,"contract_id": string,"created_at"?: string,"created_by"?: string | null,"headcount_requirement_id"?: string | null,"id"?: string,"kind"?: never,"name": string,"opened_on": string,"organisation_id": string,"role": string,"site_id": string,"status"?: string,"unit": string,"updated_at"?: string
                  }
                  Update: {
                    "band"?: string,"closed_on"?: string | null,"closed_reason"?: string | null,"contract_id"?: string,"created_at"?: string,"created_by"?: string | null,"headcount_requirement_id"?: string | null,"id"?: string,"kind"?: never,"name"?: string,"opened_on"?: string,"organisation_id"?: string,"role"?: string,"site_id"?: string,"status"?: string,"unit"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "posts_contract_fkey"
      columns: ["organisation_id","contract_id"]
isOneToOne: false
      referencedRelation: "contracts"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "posts_contract_site_fkey"
      columns: ["organisation_id","contract_id","site_id"]
isOneToOne: false
      referencedRelation: "contract_sites"
      referencedColumns: ["organisation_id","contract_id","site_id"]
    },{
      foreignKeyName: "posts_headcount_fkey"
      columns: ["organisation_id","headcount_requirement_id"]
isOneToOne: false
      referencedRelation: "headcount_requirements"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "posts_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
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
                },"punches": {
                  Row: {
                    "accuracy_m": number | null,"checkpoint_id": string | null,"client_event_id": string,"clock_drift_seconds": number,"created_at": string,"device_time": string,"distance_m": number | null,"flags": (string)[],"geofence_result": string,"id": string,"kind": string,"location": unknown,"organisation_id": string,"outside_note": string | null,"outside_reason": string | null,"payload_hash": string,"received_at": string,"recorded_at": string,"recorded_by_user": string,"selfie_deleted_at": string | null,"selfie_expected": boolean,"selfie_path": string | null,"selfie_uploaded_at": string | null,"shift_assignment_id": string | null,"shift_id": string | null,"site_id": string | null,"source": string,"time_source": string,"worker_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accuracy_m"?: number | null,"checkpoint_id"?: string | null,"client_event_id": string,"clock_drift_seconds": number,"created_at"?: string,"device_time": string,"distance_m"?: number | null,"flags"?: (string)[],"geofence_result": string,"id"?: string,"kind": string,"location"?: unknown,"organisation_id": string,"outside_note"?: string | null,"outside_reason"?: string | null,"payload_hash": string,"received_at"?: string,"recorded_at": string,"recorded_by_user": string,"selfie_deleted_at"?: string | null,"selfie_expected"?: boolean,"selfie_path"?: string | null,"selfie_uploaded_at"?: string | null,"shift_assignment_id"?: string | null,"shift_id"?: string | null,"site_id"?: string | null,"source"?: string,"time_source": string,"worker_id": string
                  }
                  Update: {
                    "accuracy_m"?: number | null,"checkpoint_id"?: string | null,"client_event_id"?: string,"clock_drift_seconds"?: number,"created_at"?: string,"device_time"?: string,"distance_m"?: number | null,"flags"?: (string)[],"geofence_result"?: string,"id"?: string,"kind"?: string,"location"?: unknown,"organisation_id"?: string,"outside_note"?: string | null,"outside_reason"?: string | null,"payload_hash"?: string,"received_at"?: string,"recorded_at"?: string,"recorded_by_user"?: string,"selfie_deleted_at"?: string | null,"selfie_expected"?: boolean,"selfie_path"?: string | null,"selfie_uploaded_at"?: string | null,"shift_assignment_id"?: string | null,"shift_id"?: string | null,"site_id"?: string | null,"source"?: string,"time_source"?: string,"worker_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "punches_assignment_fkey"
      columns: ["organisation_id","shift_assignment_id"]
isOneToOne: false
      referencedRelation: "shift_assignments"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "punches_checkpoint_fkey"
      columns: ["organisation_id","checkpoint_id"]
isOneToOne: false
      referencedRelation: "site_checkpoints"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "punches_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "punches_shift_fkey"
      columns: ["organisation_id","shift_id"]
isOneToOne: false
      referencedRelation: "shifts"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "punches_site_fkey"
      columns: ["organisation_id","site_id"]
isOneToOne: false
      referencedRelation: "sites"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "punches_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"rate_card_lines": {
                  Row: {
                    "band": string,"created_at": string,"created_by": string | null,"currency": string,"id": string,"organisation_id": string,"ot_multiplier_bps": number | null,"ot_rate_kobo": number | null,"rate_card_id": string,"rate_kobo": number,"role": string,"service_type": string,"sort_order": number,"unit": string,"wht_rate_bps": number
                  }
                  ComputedFields: never
                  Insert: {
                    "band"?: string,"created_at"?: string,"created_by"?: string | null,"currency"?: string,"id"?: string,"organisation_id": string,"ot_multiplier_bps"?: number | null,"ot_rate_kobo"?: number | null,"rate_card_id": string,"rate_kobo": number,"role": string,"service_type"?: string,"sort_order"?: number,"unit": string,"wht_rate_bps": number
                  }
                  Update: {
                    "band"?: string,"created_at"?: string,"created_by"?: string | null,"currency"?: string,"id"?: string,"organisation_id"?: string,"ot_multiplier_bps"?: number | null,"ot_rate_kobo"?: number | null,"rate_card_id"?: string,"rate_kobo"?: number,"role"?: string,"service_type"?: string,"sort_order"?: number,"unit"?: string,"wht_rate_bps"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "rate_card_lines_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "rate_card_lines_rate_card_fkey"
      columns: ["organisation_id","rate_card_id"]
isOneToOne: false
      referencedRelation: "rate_cards"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"rate_cards": {
                  Row: {
                    "contract_id": string,"created_at": string,"created_by": string | null,"effective_from": string,"effective_to": string | null,"id": string,"note": string | null,"organisation_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "contract_id": string,"created_at"?: string,"created_by"?: string | null,"effective_from": string,"effective_to"?: string | null,"id"?: string,"note"?: string | null,"organisation_id": string,"updated_at"?: string
                  }
                  Update: {
                    "contract_id"?: string,"created_at"?: string,"created_by"?: string | null,"effective_from"?: string,"effective_to"?: string | null,"id"?: string,"note"?: string | null,"organisation_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "rate_cards_contract_fkey"
      columns: ["organisation_id","contract_id"]
isOneToOne: false
      referencedRelation: "contracts"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "rate_cards_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"roster_publications": {
                  Row: {
                    "assigned_count": number,"id": string,"open_count": number,"organisation_id": string,"published_at": string,"published_by": string | null,"site_id": string,"snapshot": NonNullable<Json>,"version": number,"week_start": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assigned_count"?: number,"id"?: string,"open_count"?: number,"organisation_id": string,"published_at"?: string,"published_by"?: string | null,"site_id": string,"snapshot"?: NonNullable<Json>,"version": number,"week_start": string
                  }
                  Update: {
                    "assigned_count"?: number,"id"?: string,"open_count"?: number,"organisation_id"?: string,"published_at"?: string,"published_by"?: string | null,"site_id"?: string,"snapshot"?: NonNullable<Json>,"version"?: number,"week_start"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "roster_publications_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "roster_publications_site_fkey"
      columns: ["organisation_id","site_id"]
isOneToOne: false
      referencedRelation: "sites"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"roster_requirements": {
                  Row: {
                    "contract_id": string,"created_at": string,"created_by": string | null,"days_of_week": (number)[],"duration_minutes": number | null,"effective_from": string,"effective_to": string | null,"end_time": string,"id": string,"organisation_id": string,"post_id": string,"required_count": number,"site_id": string,"start_time": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "contract_id": string,"created_at"?: string,"created_by"?: string | null,"days_of_week": (number)[],"duration_minutes"?: never,"effective_from": string,"effective_to"?: string | null,"end_time": string,"id"?: string,"organisation_id": string,"post_id": string,"required_count": number,"site_id": string,"start_time": string,"updated_at"?: string
                  }
                  Update: {
                    "contract_id"?: string,"created_at"?: string,"created_by"?: string | null,"days_of_week"?: (number)[],"duration_minutes"?: never,"effective_from"?: string,"effective_to"?: string | null,"end_time"?: string,"id"?: string,"organisation_id"?: string,"post_id"?: string,"required_count"?: number,"site_id"?: string,"start_time"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "roster_requirements_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "roster_requirements_post_fkey"
      columns: ["organisation_id","post_id","contract_id","site_id"]
isOneToOne: false
      referencedRelation: "posts"
      referencedColumns: ["organisation_id","id","contract_id","site_id"]
    }
                  ]
                },"shift_assignments": {
                  Row: {
                    "assigned_at": string,"assigned_by": string | null,"created_at": string,"ends_at": string,"id": string,"organisation_id": string,"removed_at": string | null,"removed_by": string | null,"removed_reason": string | null,"shift_date": string,"shift_id": string,"site_id": string,"starts_at": string,"status": string,"worker_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assigned_at"?: string,"assigned_by"?: string | null,"created_at"?: string,"ends_at": string,"id"?: string,"organisation_id": string,"removed_at"?: string | null,"removed_by"?: string | null,"removed_reason"?: string | null,"shift_date": string,"shift_id": string,"site_id": string,"starts_at": string,"status"?: string,"worker_id": string
                  }
                  Update: {
                    "assigned_at"?: string,"assigned_by"?: string | null,"created_at"?: string,"ends_at"?: string,"id"?: string,"organisation_id"?: string,"removed_at"?: string | null,"removed_by"?: string | null,"removed_reason"?: string | null,"shift_date"?: string,"shift_id"?: string,"site_id"?: string,"starts_at"?: string,"status"?: string,"worker_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "shift_assignments_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "shift_assignments_shift_fkey"
      columns: ["organisation_id","shift_id","site_id","shift_date"]
isOneToOne: false
      referencedRelation: "shifts"
      referencedColumns: ["organisation_id","id","site_id","shift_date"]
    },{
      foreignKeyName: "shift_assignments_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"shifts": {
                  Row: {
                    "contract_id": string,"created_at": string,"created_by": string | null,"ends_at": string,"id": string,"organisation_id": string,"post_id": string,"required_count": number,"requirement_id": string | null,"shift_date": string,"site_id": string,"starts_at": string,"status": string,"updated_at": string,"work_unit_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "contract_id": string,"created_at"?: string,"created_by"?: string | null,"ends_at": string,"id"?: string,"organisation_id": string,"post_id": string,"required_count": number,"requirement_id"?: string | null,"shift_date": string,"site_id": string,"starts_at": string,"status"?: string,"updated_at"?: string,"work_unit_id"?: string | null
                  }
                  Update: {
                    "contract_id"?: string,"created_at"?: string,"created_by"?: string | null,"ends_at"?: string,"id"?: string,"organisation_id"?: string,"post_id"?: string,"required_count"?: number,"requirement_id"?: string | null,"shift_date"?: string,"site_id"?: string,"starts_at"?: string,"status"?: string,"updated_at"?: string,"work_unit_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "shifts_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "shifts_post_fkey"
      columns: ["organisation_id","post_id","contract_id","site_id"]
isOneToOne: false
      referencedRelation: "posts"
      referencedColumns: ["organisation_id","id","contract_id","site_id"]
    },{
      foreignKeyName: "shifts_requirement_fkey"
      columns: ["organisation_id","requirement_id"]
isOneToOne: false
      referencedRelation: "roster_requirements"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"site_checkpoints": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"location": unknown,"name": string,"organisation_id": string,"qr_rotated_at": string | null,"qr_token": string,"retired_at": string | null,"retired_by": string | null,"site_id": string,"sort_order": number,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"location"?: unknown,"name": string,"organisation_id": string,"qr_rotated_at"?: string | null,"qr_token"?: string,"retired_at"?: string | null,"retired_by"?: string | null,"site_id": string,"sort_order"?: number,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"location"?: unknown,"name"?: string,"organisation_id"?: string,"qr_rotated_at"?: string | null,"qr_token"?: string,"retired_at"?: string | null,"retired_by"?: string | null,"site_id"?: string,"sort_order"?: number,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "site_checkpoints_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "site_checkpoints_site_fkey"
      columns: ["organisation_id","site_id"]
isOneToOne: false
      referencedRelation: "sites"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"sites": {
                  Row: {
                    "address": string | null,"boundary": unknown,"centre": unknown,"client_id": string,"created_at": string,"created_by": string | null,"geofence": unknown,"geofence_set_at": string | null,"geofence_set_by": string | null,"id": string,"landmark": string | null,"name": string,"organisation_id": string,"radius_m": number,"state": string | null,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"boundary"?: unknown,"centre"?: unknown,"client_id": string,"created_at"?: string,"created_by"?: string | null,"geofence"?: unknown,"geofence_set_at"?: string | null,"geofence_set_by"?: string | null,"id"?: string,"landmark"?: string | null,"name": string,"organisation_id": string,"radius_m"?: number,"state"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "address"?: string | null,"boundary"?: unknown,"centre"?: unknown,"client_id"?: string,"created_at"?: string,"created_by"?: string | null,"geofence"?: unknown,"geofence_set_at"?: string | null,"geofence_set_by"?: string | null,"id"?: string,"landmark"?: string | null,"name"?: string,"organisation_id"?: string,"radius_m"?: number,"state"?: string | null,"status"?: string,"updated_at"?: string
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
                },"staff_id_corrections": {
                  Row: {
                    "approved_by": string | null,"cancelled_by": string | null,"created_at": string,"decided_at": string | null,"decision_note": string | null,"id": string,"new_staff_id": string,"old_staff_id": string,"organisation_id": string,"reason": string,"rejected_by": string | null,"requested_by": string,"status": Database["public"]['Enums']["staff_id_correction_status"],"updated_at": string,"worker_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "approved_by"?: string | null,"cancelled_by"?: string | null,"created_at"?: string,"decided_at"?: string | null,"decision_note"?: string | null,"id"?: string,"new_staff_id": string,"old_staff_id": string,"organisation_id": string,"reason": string,"rejected_by"?: string | null,"requested_by"?: string,"status"?: Database["public"]['Enums']["staff_id_correction_status"],"updated_at"?: string,"worker_id": string
                  }
                  Update: {
                    "approved_by"?: string | null,"cancelled_by"?: string | null,"created_at"?: string,"decided_at"?: string | null,"decision_note"?: string | null,"id"?: string,"new_staff_id"?: string,"old_staff_id"?: string,"organisation_id"?: string,"reason"?: string,"rejected_by"?: string | null,"requested_by"?: string,"status"?: Database["public"]['Enums']["staff_id_correction_status"],"updated_at"?: string,"worker_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "staff_id_corrections_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "staff_id_corrections_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
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
                },"worker_change_requests": {
                  Row: {
                    "created_at": string,"details": string,"id": string,"organisation_id": string,"requested_by": string,"resolution_note": string | null,"resolved_at": string | null,"resolved_by": string | null,"status": Database["public"]['Enums']["worker_change_request_status"],"topic": Database["public"]['Enums']["worker_change_topic"],"updated_at": string,"worker_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"details": string,"id"?: string,"organisation_id": string,"requested_by"?: string,"resolution_note"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"status"?: Database["public"]['Enums']["worker_change_request_status"],"topic": Database["public"]['Enums']["worker_change_topic"],"updated_at"?: string,"worker_id": string
                  }
                  Update: {
                    "created_at"?: string,"details"?: string,"id"?: string,"organisation_id"?: string,"requested_by"?: string,"resolution_note"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"status"?: Database["public"]['Enums']["worker_change_request_status"],"topic"?: Database["public"]['Enums']["worker_change_topic"],"updated_at"?: string,"worker_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "worker_change_requests_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "worker_change_requests_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"worker_consents": {
                  Row: {
                    "accepted_at": string,"channel": string,"created_by": string | null,"id": string,"kind": string,"notice_version": string,"organisation_id": string,"withdrawn_at": string | null,"worker_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string,"channel"?: string,"created_by"?: string | null,"id"?: string,"kind": string,"notice_version": string,"organisation_id": string,"withdrawn_at"?: string | null,"worker_id": string
                  }
                  Update: {
                    "accepted_at"?: string,"channel"?: string,"created_by"?: string | null,"id"?: string,"kind"?: string,"notice_version"?: string,"organisation_id"?: string,"withdrawn_at"?: string | null,"worker_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "worker_consents_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "worker_consents_worker_fkey"
      columns: ["organisation_id","worker_id"]
isOneToOne: false
      referencedRelation: "workers"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"worker_credentials": {
                  Row: {
                    "auth_user_id": string,"created_at": string,"failed_attempts": number,"held_at": string | null,"id": string,"last_sign_in_at": string | null,"locked_until": string | null,"organisation_id": string,"pin_set_at": string,"privacy_notice_accepted_at": string,"updated_at": string,"worker_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "auth_user_id": string,"created_at"?: string,"failed_attempts"?: number,"held_at"?: string | null,"id"?: string,"last_sign_in_at"?: string | null,"locked_until"?: string | null,"organisation_id": string,"pin_set_at"?: string,"privacy_notice_accepted_at": string,"updated_at"?: string,"worker_id": string
                  }
                  Update: {
                    "auth_user_id"?: string,"created_at"?: string,"failed_attempts"?: number,"held_at"?: string | null,"id"?: string,"last_sign_in_at"?: string | null,"locked_until"?: string | null,"organisation_id"?: string,"pin_set_at"?: string,"privacy_notice_accepted_at"?: string,"updated_at"?: string,"worker_id"?: string
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
                    "account_name": string | null,"annual_rent_declared_kobo": number | null,"bank_account_enc": string | null,"bank_account_last4": string | null,"bank_checked_at": string | null,"bank_checked_by": string | null,"bank_checked_code": string | null,"bank_checked_name": string | null,"bank_checked_source": string | null,"bank_code": string | null,"bank_name": string | null,"created_at": string,"created_by": string | null,"currency": string,"department_id": string | null,"email": string | null,"employment_type": Database["public"]['Enums']["employment_type"],"end_date": string | null,"first_name": string,"id": string,"job_title": string | null,"last_name": string,"line_manager_membership_id": string | null,"line_manager_worker_id": string | null,"needs_pay_details": boolean,"next_of_kin_name": string | null,"next_of_kin_phone": string | null,"nhf_opt_in": boolean,"nin_enc": string | null,"organisation_id": string,"pfa_name": string | null,"phone": string | null,"rsa_pin_enc": string | null,"rsa_pin_last4": string | null,"staff_id": string,"start_date": string,"status": Database["public"]['Enums']["worker_status"],"supervisor_clock_in": boolean,"tax_state": string | null,"tin": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_name"?: string | null,"annual_rent_declared_kobo"?: number | null,"bank_account_enc"?: string | null,"bank_account_last4"?: string | null,"bank_checked_at"?: string | null,"bank_checked_by"?: string | null,"bank_checked_code"?: string | null,"bank_checked_name"?: string | null,"bank_checked_source"?: string | null,"bank_code"?: string | null,"bank_name"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency"?: string,"department_id"?: string | null,"email"?: string | null,"employment_type": Database["public"]['Enums']["employment_type"],"end_date"?: string | null,"first_name": string,"id"?: string,"job_title"?: string | null,"last_name": string,"line_manager_membership_id"?: string | null,"line_manager_worker_id"?: string | null,"needs_pay_details"?: boolean,"next_of_kin_name"?: string | null,"next_of_kin_phone"?: string | null,"nhf_opt_in"?: boolean,"nin_enc"?: string | null,"organisation_id": string,"pfa_name"?: string | null,"phone"?: string | null,"rsa_pin_enc"?: string | null,"rsa_pin_last4"?: string | null,"staff_id": string,"start_date": string,"status"?: Database["public"]['Enums']["worker_status"],"supervisor_clock_in"?: boolean,"tax_state"?: string | null,"tin"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "account_name"?: string | null,"annual_rent_declared_kobo"?: number | null,"bank_account_enc"?: string | null,"bank_account_last4"?: string | null,"bank_checked_at"?: string | null,"bank_checked_by"?: string | null,"bank_checked_code"?: string | null,"bank_checked_name"?: string | null,"bank_checked_source"?: string | null,"bank_code"?: string | null,"bank_name"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency"?: string,"department_id"?: string | null,"email"?: string | null,"employment_type"?: Database["public"]['Enums']["employment_type"],"end_date"?: string | null,"first_name"?: string,"id"?: string,"job_title"?: string | null,"last_name"?: string,"line_manager_membership_id"?: string | null,"line_manager_worker_id"?: string | null,"needs_pay_details"?: boolean,"next_of_kin_name"?: string | null,"next_of_kin_phone"?: string | null,"nhf_opt_in"?: boolean,"nin_enc"?: string | null,"organisation_id"?: string,"pfa_name"?: string | null,"phone"?: string | null,"rsa_pin_enc"?: string | null,"rsa_pin_last4"?: string | null,"staff_id"?: string,"start_date"?: string,"status"?: Database["public"]['Enums']["worker_status"],"supervisor_clock_in"?: boolean,"tax_state"?: string | null,"tin"?: string | null,"updated_at"?: string
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
"accept_worker_consent":
{ Args: { "p_kind": string,"p_notice_version": string,"p_organisation_id": string }; Returns: string
                           },
"accept_worker_invite":
{ Args: { "p_auth_user_id": string,"p_pin_hash": string,"p_token": string }; Returns: {
              "organisation_id": string,"pin_reset": boolean,"worker_id": string
            }[]
                           },
"activate_contract":
{ Args: { "p_contract_id": string,"p_go_live_date"?: string,"p_organisation_id": string,"p_send_welcome"?: boolean }; Returns: Json
                           },
"add_contract_site":
{ Args: { "p_contract_id": string,"p_note"?: string,"p_organisation_id": string,"p_site_id": string }; Returns: Json
                           },
"add_pay_rate":
{ Args: { "p_organisation_id": string,"p_rate": Json,"p_worker_id": string }; Returns: string
                           },
"add_post":
{ Args: { "p_add_site"?: boolean,"p_band": string,"p_contract_id": string,"p_count": number,"p_days": (number)[],"p_end": string,"p_from": string,"p_note"?: string,"p_organisation_id": string,"p_post_name": string,"p_role": string,"p_site_id": string,"p_start": string,"p_unit": string }; Returns: Json
                           },
"add_rate_card_version":
{ Args: { "p_contract_id": string,"p_effective_from": string,"p_lines": Json,"p_note"?: string,"p_organisation_id": string }; Returns: string
                           },
"apply_due_bank_detail_changes":
{ Args: { "p_organisation_id": string }; Returns: number
                           },
"apply_due_org_bank_accounts":
{ Args: { "p_organisation_id": string }; Returns: number
                           },
"assign_worker_to_shift":
{ Args: { "p_organisation_id": string,"p_post_id": string,"p_shift_date": string,"p_worker_id": string }; Returns: Json
                           },
"attach_punch_selfie":
{ Args: { "p_actor": string,"p_path": string,"p_punch_id": string }; Returns: undefined
                           },
"begin_bank_account_lookup":
{ Args: { "p_bank_account_digest": string,"p_bank_account_last4": string,"p_bank_code": string,"p_client_ip"?: string,"p_organisation_id": string,"p_purpose": Database["public"]['Enums']["bank_lookup_purpose"],"p_user_id": string,"p_worker_id": string }; Returns: string
                           },
"begin_punch_selfie_upload":
{ Args: { "p_actor": string,"p_punch_id": string }; Returns: undefined
                           },
"cancel_import_batch":
{ Args: { "p_batch_id": string,"p_organisation_id": string }; Returns: undefined
                           },
"cancel_pay_rate":
{ Args: { "p_organisation_id": string,"p_pay_rate_id": string }; Returns: undefined
                           },
"cancel_post_requirement_change":
{ Args: { "p_note"?: string,"p_organisation_id": string,"p_requirement_id": string }; Returns: Json
                           },
"cancel_rate_card_version":
{ Args: { "p_organisation_id": string,"p_rate_card_id": string }; Returns: undefined
                           },
"change_member_role":
{ Args: { "p_membership_id": string,"p_organisation_id": string,"p_role": Database["public"]['Enums']["membership_role"] }; Returns: {
              "member_email": string,"member_name": string,"member_user_id": string,"new_role": Database["public"]['Enums']["membership_role"],"old_role": Database["public"]['Enums']["membership_role"]
            }[]
                           },
"change_post_requirement":
{ Args: { "p_count": number,"p_days": (number)[],"p_end": string,"p_from": string,"p_note"?: string,"p_organisation_id": string,"p_post_id": string,"p_start": string }; Returns: Json
                           },
"choose_company_plan":
{ Args: { "p_expected_workers": number,"p_organisation_id": string,"p_plan": string }; Returns: undefined
                           },
"claim_inbox_email":
{ Args: { "p_global_cap": number,"p_item_id": string,"p_org_cap": number }; Returns: boolean
                           },
"clear_punch_selfies":
{ Args: { "p_punch_ids": (string)[] }; Returns: number
                           },
"client_billing":
{ Args: { "p_client_id"?: string,"p_organisation_id": string }; Returns: {
              "billing_address": string,"billing_terms_days": number,"client_id": string,"deducts_wht": string,"legal_name": string,"notes": string,"rc_number": string,"state": string,"tin": string,"withholds_vat": boolean
            }[]
                           },
"close_post":
{ Args: { "p_last_day": string,"p_organisation_id": string,"p_post_id": string,"p_reason": string }; Returns: Json
                           },
"commit_import_batch":
{ Args: { "p_batch_id": string,"p_organisation_id": string,"p_rows": Json }; Returns: Json
                           },
"complete_company_setup":
{ Args: { "p_organisation_id": string }; Returns: string
                           },
"confirm_contract_document":
{ Args: { "p_actor": string,"p_document_id": string,"p_organisation_id": string,"p_sha256": string,"p_size_bytes": number }; Returns: undefined
                           },
"contract_welcome_allowed":
{ Args: { "p_contact_ids": (string)[],"p_contract_id": string,"p_organisation_id": string }; Returns: string[]
                           },
"copy_last_week":
{ Args: { "p_dry_run"?: boolean,"p_organisation_id": string,"p_site_id": string,"p_week_start": string }; Returns: Json
                           },
"create_client":
{ Args: { "p_billing_address"?: string,"p_billing_terms_days"?: number,"p_contact_email"?: string,"p_contact_name"?: string,"p_contact_phone"?: string,"p_legal_name"?: string,"p_name": string,"p_notes"?: string,"p_organisation_id": string,"p_rc_number"?: string,"p_site_name"?: string,"p_state"?: string,"p_tin"?: string }; Returns: string
                           },
"create_contract":
{ Args: { "p_contract": Json,"p_organisation_id": string,"p_site_ids"?: (string)[] }; Returns: string
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
"decide_org_bank_account":
{ Args: { "p_decision": string,"p_id": string,"p_note"?: string,"p_organisation_id": string }; Returns: {
              "applies_after": string,"bank_account_last4": string,"id": string,"status": Database["public"]['Enums']["org_bank_account_status"]
            }[]
                           },
"decide_owner_change":
{ Args: { "p_change_id": string,"p_decision": string,"p_organisation_id": string }; Returns: {
              "change_id": string,"change_status": Database["public"]['Enums']["owner_change_status"],"invite_token": string
            }[]
                           },
"email_link_allowed":
{ Args: { "p_keys": (string)[] }; Returns: boolean
                           },
"end_contract":
{ Args: { "p_contract_id": string,"p_end_date": string,"p_organisation_id": string,"p_reason": string }; Returns: Json
                           },
"end_employment":
{ Args: { "p_end_date": string,"p_organisation_id": string,"p_worker_id": string }; Returns: undefined
                           },
"end_other_sessions":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"finish_bank_account_lookup":
{ Args: { "p_account_name"?: string,"p_id": string,"p_source"?: string,"p_status": Database["public"]['Enums']["bank_lookup_status"] }; Returns: boolean
                           },
"list_import_managers":
{ Args: { "p_organisation_id": string }; Returns: {
              "email": string,"full_name": string,"membership_id": string
            }[]
                           },
"log_audit":
{ Args: { "p_action": string,"p_after"?: Json,"p_before"?: Json,"p_entity": string,"p_entity_id"?: string,"p_organisation_id": string,"p_reason"?: string }; Returns: string
                           },
"membership_invite_lookup":
{ Args: { "p_token": string }; Returns: {
              "email": string,"expires_at": string,"invite_id": string,"invited_at": string,"inviter_name": string,"organisation_id": string,"organisation_name": string,"role": Database["public"]['Enums']["membership_role"],"state": string
            }[]
                           },
"move_site_checkpoint":
{ Args: { "p_checkpoint_id": string,"p_direction": string,"p_organisation_id": string }; Returns: number
                           },
"my_clock_context":
{ Args: { "p_organisation_id": string }; Returns: Json
                           },
"my_line_manager":
{ Args: { "p_organisation_id": string }; Returns: {
              "has_line_manager": boolean,"name": string
            }[]
                           },
"my_published_shifts":
{ Args: { "p_from": string,"p_to": string }; Returns: {
              "assignment_id": string,"ends_at": string,"organisation_id": string,"post_name": string,"shift_date": string,"site_address": string,"site_landmark": string,"site_name": string,"starts_at": string
            }[]
                           },
"org_bank_account_as_of":
{ Args: { "p_at"?: string,"p_organisation_id": string }; Returns: {
              "account_name": string,"bank_account_enc": string,"bank_account_last4": string,"bank_name": string,"id": string,"in_force_from": string
            }[]
                           },
"org_bank_account_masked":
{ Args: { "p_organisation_id": string }; Returns: {
              "account_name": string,"bank_account_last4": string,"bank_name": string,"id": string,"in_force_from": string
            }[]
                           },
"publish_roster":
{ Args: { "p_dry_run"?: boolean,"p_organisation_id": string,"p_site_id": string,"p_week_start": string }; Returns: Json
                           },
"punch_locations":
{ Args: { "p_organisation_id": string,"p_punch_ids": (string)[] }; Returns: {
              "accuracy_m": number,"latitude": number,"longitude": number,"punch_id": string
            }[]
                           },
"punch_photo_orphans":
{ Args: { "p_limit"?: number }; Returns: string[]
                           },
"punch_selfies_due":
{ Args: { "p_limit"?: number }; Returns: {
              "punch_id": string,"selfie_path": string
            }[]
                           },
"record_checkpoint_scan":
{ Args: { "p_accuracy_m": number,"p_client_event_id": string,"p_device_time": string,"p_elapsed_ms": number,"p_expected_organisation_id": string,"p_expected_worker_id": string,"p_latitude": number,"p_longitude": number,"p_sent_device_time": string,"p_token": string }; Returns: Json
                           },
"record_punch":
{ Args: { "p_accuracy_m": number,"p_client_event_id": string,"p_device_time": string,"p_elapsed_ms": number,"p_expected_organisation_id": string,"p_expected_worker_id": string,"p_has_selfie": boolean,"p_kind": string,"p_latitude": number,"p_longitude": number,"p_outside_note": string,"p_outside_reason": string,"p_sent_device_time": string,"p_site_id": string }; Returns: Json
                           },
"reject_contract_document":
{ Args: { "p_actor": string,"p_document_id": string,"p_organisation_id": string }; Returns: undefined
                           },
"remove_assignment":
{ Args: { "p_assignment_id": string,"p_organisation_id": string,"p_reason"?: string }; Returns: Json
                           },
"remove_contract_document":
{ Args: { "p_document_id": string,"p_organisation_id": string,"p_reason": string }; Returns: undefined
                           },
"remove_member":
{ Args: { "p_membership_id": string,"p_organisation_id": string }; Returns: {
              "member_email": string,"member_name": string,"member_user_id": string,"old_role": Database["public"]['Enums']["membership_role"]
            }[]
                           },
"request_org_bank_account":
{ Args: { "p_account_name": string,"p_bank_account_digest"?: string,"p_bank_account_enc": string,"p_bank_account_last4": string,"p_bank_code"?: string,"p_bank_lookup_id"?: string,"p_bank_name": string,"p_id": string,"p_name_check"?: Database["public"]['Enums']["bank_name_check"],"p_name_check_reason"?: string,"p_organisation_id": string,"p_reason"?: string }; Returns: {
              "account_name": string,"id": string,"single_approver": boolean,"status": Database["public"]['Enums']["org_bank_account_status"]
            }[]
                           },
"request_owner_change":
{ Args: { "p_email"?: string,"p_kind": Database["public"]['Enums']["owner_change_kind"],"p_membership_id"?: string,"p_new_role"?: Database["public"]['Enums']["membership_role"],"p_organisation_id": string,"p_reason"?: string }; Returns: {
              "change_id": string,"change_status": Database["public"]['Enums']["owner_change_status"],"invite_token": string
            }[]
                           },
"required_shifts":
{ Args: { "p_from": string,"p_organisation_id": string,"p_to": string }; Returns: {
              "band": string,"contract_id": string,"ends_at": string,"kind": string,"post_id": string,"post_name": string,"required_count": number,"requirement_id": string,"role": string,"shift_date": string,"site_id": string,"starts_at": string,"unit": string
            }[]
                           },
"resend_membership_invite":
{ Args: { "p_invite_id": string,"p_organisation_id": string }; Returns: {
              "invite_email": string,"invite_expires_at": string,"invite_role": Database["public"]['Enums']["membership_role"],"token": string
            }[]
                           },
"revoke_membership_invite":
{ Args: { "p_invite_id": string,"p_organisation_id": string }; Returns: undefined
                           },
"roster_assignment_details":
{ Args: { "p_from": string,"p_organisation_id": string,"p_site_id": string,"p_to": string }; Returns: {
              "assigned_at": string,"assigned_by": string,"id": string,"removed_at": string,"removed_by": string,"removed_reason": string
            }[]
                           },
"roster_notice_targets":
{ Args: { "p_organisation_id": string,"p_site_id": string,"p_week_start": string }; Returns: Json
                           },
"roster_publication_status":
{ Args: { "p_organisation_id": string,"p_site_id": string,"p_week_start": string }; Returns: Json
                           },
"rotate_checkpoint_qr":
{ Args: { "p_checkpoint_id": string,"p_organisation_id": string }; Returns: undefined
                           },
"save_draft_rate_card":
{ Args: { "p_contract_id": string,"p_effective_from": string,"p_lines": Json,"p_note"?: string,"p_organisation_id": string }; Returns: string
                           },
"save_import_check":
{ Args: { "p_batch_id": string,"p_check": Json,"p_final": boolean,"p_organisation_id": string,"p_rows": Json }; Returns: undefined
                           },
"save_worker_mapping":
{ Args: { "p_department_id"?: string,"p_line_manager_membership_id"?: string,"p_line_manager_worker_id"?: string,"p_organisation_id": string,"p_project_ids"?: (string)[],"p_site_id"?: string,"p_worker_id": string }; Returns: Json
                           },
"set_client_tax_settings":
{ Args: { "p_client_id": string,"p_deducts_wht": string,"p_organisation_id": string,"p_reason"?: string,"p_withholds_vat": boolean }; Returns: undefined
                           },
"set_company_business_type":
{ Args: { "p_business_type": string,"p_organisation_id": string }; Returns: Json
                           },
"set_company_modules":
{ Args: { "p_organisation_id": string,"p_payroll_enabled": boolean,"p_people_enabled": boolean,"p_shifts_enabled": boolean }; Returns: Json
                           },
"site_checkpoint_tokens":
{ Args: { "p_organisation_id": string,"p_site_id": string }; Returns: {
              "checkpoint_id": string,"name": string,"qr_token": string,"sort_order": number
            }[]
                           },
"site_geofences":
{ Args: { "p_organisation_id": string,"p_site_id"?: string }; Returns: {
              "area_m2": number,"boundary": Json,"centre_lat": number,"centre_lng": number,"radius_m": number,"site_id": string
            }[]
                           },
"team_members":
{ Args: { "p_organisation_id": string }; Returns: {
              "email": string,"full_name": string,"joined_at": string,"membership_id": string,"role": Database["public"]['Enums']["membership_role"],"user_id": string
            }[]
                           },
"unlock_worker_sign_in":
{ Args: { "p_organisation_id": string,"p_worker_id": string }; Returns: string
                           },
"update_draft_contract":
{ Args: { "p_contract": Json,"p_contract_id": string,"p_organisation_id": string,"p_site_ids"?: (string)[] }; Returns: string
                           },
"withdraw_org_bank_account":
{ Args: { "p_id": string,"p_organisation_id": string }; Returns: string
                           },
"withdraw_worker_consent":
{ Args: { "p_kind": string,"p_organisation_id": string }; Returns: boolean
                           },
"worker_bank_details_as_of":
{ Args: { "p_at"?: string,"p_organisation_id": string,"p_worker_id": string }; Returns: {
              "account_name": string,"bank_account_enc": string,"bank_account_last4": string,"bank_detail_change_id": string,"bank_name": string
            }[]
                           },
"worker_invite_lookup":
{ Args: { "p_token": string }; Returns: {
              "auth_user_id": string,"company_code": string,"first_name": string,"invite_id": string,"last_name": string,"organisation_id": string,"organisation_name": string,"staff_id": string,"state": string,"worker_id": string
            }[]
                           },
"worker_line_manager_contact":
{ Args: { "p_organisation_id": string,"p_worker_id": string }; Returns: {
              "email": string,"name": string,"user_id": string
            }[]
                           },
"worker_sign_in_begin":
{ Args: { "p_company_code": string,"p_ip_key": string,"p_staff_id": string }; Returns: {
              "alert_organisation_id": string,"auth_user_id": string,"begun_at": string,"holds_on_failure": boolean,"locks_on_failure": boolean,"organisation_id": string,"outcome": string,"pin_hash": string,"worker_id": string
            }[]
                           },
"worker_sign_in_finish":
{ Args: { "p_begun_at"?: string,"p_ip_key": string,"p_ok": boolean,"p_worker_id": string }; Returns: {
              "alert_organisation_id": string,"outcome": string
            }[]
                           },
"worker_sign_in_status":
{ Args: { "p_organisation_id": string,"p_worker_id": string }; Returns: {
              "failed_attempts": number,"has_login": boolean,"held_at": string,"last_sign_in_at": string,"locked_until": string,"pin_set_at": string
            }[]
                           }
          }
          Enums: {
            "bank_detail_change_status": "pending"|"approved"|"rejected"|"applied"|"cancelled","bank_lookup_purpose": "company_bank"|"worker_bank"|"worker_check","bank_lookup_status": "pending"|"resolved"|"not_found"|"failed","bank_name_check": "match"|"near"|"no_match"|"not_checked","employment_type": "permanent"|"contract"|"casual"|"daily","import_batch_status": "uploaded"|"validated"|"committed"|"cancelled","import_row_status": "ready"|"held"|"fixed"|"imported","membership_role": "owner"|"admin"|"hr"|"finance"|"ops_manager"|"line_manager"|"worker"|"client_approver","org_bank_account_status": "pending"|"approved"|"active"|"retired"|"rejected"|"cancelled","owner_change_kind": "add"|"invite"|"remove"|"demote","owner_change_status": "pending"|"approved"|"rejected"|"cancelled","pay_type": "monthly"|"daily"|"hourly","staff_id_correction_status": "pending"|"approved"|"rejected"|"cancelled","worker_change_request_status": "open"|"done"|"declined","worker_change_topic": "name"|"phone"|"email"|"next_of_kin"|"nin"|"tax_pension"|"work"|"other","worker_status": "active"|"ended"
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
            "bank_detail_change_status": ["pending", "approved", "rejected", "applied", "cancelled"],"bank_lookup_purpose": ["company_bank", "worker_bank", "worker_check"],"bank_lookup_status": ["pending", "resolved", "not_found", "failed"],"bank_name_check": ["match", "near", "no_match", "not_checked"],"employment_type": ["permanent", "contract", "casual", "daily"],"import_batch_status": ["uploaded", "validated", "committed", "cancelled"],"import_row_status": ["ready", "held", "fixed", "imported"],"membership_role": ["owner", "admin", "hr", "finance", "ops_manager", "line_manager", "worker", "client_approver"],"org_bank_account_status": ["pending", "approved", "active", "retired", "rejected", "cancelled"],"owner_change_kind": ["add", "invite", "remove", "demote"],"owner_change_status": ["pending", "approved", "rejected", "cancelled"],"pay_type": ["monthly", "daily", "hourly"],"staff_id_correction_status": ["pending", "approved", "rejected", "cancelled"],"worker_change_request_status": ["open", "done", "declined"],"worker_change_topic": ["name", "phone", "email", "next_of_kin", "nin", "tax_pension", "work", "other"],"worker_status": ["active", "ended"]
          }
        }
} as const
