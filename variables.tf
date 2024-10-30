variable "prefix" {
  default     = "email-forward"
  description = "All resources will be tagged using this prefix name"
}

variable "s3_bucket" {
  type        = string
  description = "Bucket where emails will be stored"
}

variable "s3_bucket_prefix" {
  type        = string
  description = "Path inside the bucket where emails will be stored, must contain trailing slash"
  default     = ""
}

variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region where we should configure the integration"
}

variable "domain" {
  type        = string
  description = "Domain to configure (ex: aleix.cloud)"
}
variable "emails" {
  description = "Map of account_names to reciepent emails"
  type        = map(list(string))
  default     = {}
}
