output "smtp_password" {
  value = [for key, value in aws_iam_access_key.smtp : {
    name = key
    password = value.ses_smtp_password_v4
    userid = value.id
  }]
  sensitive = true
}
