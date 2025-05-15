resource "null_resource" "npm_install" {
  provisioner "local-exec" {
    command = "cd ${path.module}/code && npm install"
  }
}

data "archive_file" "zipit" {
  depends_on  = [null_resource.npm_install]
  type        = "zip"
  source_dir  = "${path.module}/code/"
  output_path = "${path.module}/code.zip"
}

/** AWS account id */
data "aws_caller_identity" "current" {}


/** Lambda Components */


resource "aws_iam_policy" "lambda_policy" {
  name = "${var.prefix}-lambda-policy"
  path = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "S3Access",
            "Effect": "Allow",
            "Action": [
                "s3:PutObject",
                "s3:GetObject",
                "s3:ListBucket",
                "s3:DeleteObject"
            ],
            "Resource": [
                "arn:aws:s3:::${var.s3_bucket}/${trimprefix(var.s3_bucket_prefix, "/")}${!endswith(var.s3_bucket_prefix, "/") && var.s3_bucket_prefix != "" ? "/" : ""}*"
            ]
        },
        {
            "Sid": "SESAccess",
            "Effect": "Allow",
            "Action": [
                "ses:SendRawEmail"
            ],
            "Resource": ${jsonencode(concat([for item in aws_ses_email_identity.email : item.arn], [aws_ses_domain_identity.domain.arn]))}
        }
    ]
}
EOF
}

resource "aws_iam_role" "lambda_role" {
  name = "${var.prefix}-lambda-role"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
}

resource "aws_iam_role_policy_attachment" "lambda_logs_policy_attachment" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_email_fw_attachment" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = aws_iam_policy.lambda_policy.arn
}

resource "aws_lambda_function" "lambda_function" {
  filename         = data.archive_file.zipit.output_path
  function_name    = "${var.prefix}-function"
  role             = aws_iam_role.lambda_role.arn
  handler          = "email-forward.handler"
  source_code_hash = data.archive_file.zipit.output_base64sha256

  timeout = 30
  runtime = "nodejs16.x"

  environment {
    variables = {
      MailS3Bucket  = var.s3_bucket
      MailS3Prefix  = "${trimprefix(var.s3_bucket_prefix, "/")}${!endswith(var.s3_bucket_prefix, "/") && var.s3_bucket_prefix != "" ? "/" : ""}"
      EmailsMapping = jsonencode(var.emails)
      Region        = var.aws_region
    }
  }
}

resource "aws_lambda_permission" "allow_ses" {
  statement_id  = "GiveSESPermissionToInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lambda_function.function_name
  principal     = "ses.amazonaws.com"
}

/** SES Components */

resource "aws_ses_receipt_rule_set" "fw_rules" {
  rule_set_name = local.rule_set_name
}

resource "aws_ses_active_receipt_rule_set" "main" {
  rule_set_name = local.rule_set_name
}

resource "aws_ses_receipt_rule" "fw" {
  name          = var.prefix
  rule_set_name = local.rule_set_name
  recipients    = [for key, value in var.emails : "${key}@${var.domain}"]
  enabled       = true
  scan_enabled  = false

  s3_action {
    bucket_name = var.s3_bucket
    position    = 1
  }

  lambda_action {
    function_arn    = aws_lambda_function.lambda_function.arn
    invocation_type = "Event"
    position        = 2
  }
}

resource "aws_ses_domain_identity" "domain" {
  domain = var.domain
}

resource "aws_ses_domain_dkim" "dkim" {
  domain = aws_ses_domain_identity.domain.domain
}

resource "aws_ses_domain_mail_from" "domain" {
  domain           = aws_ses_domain_identity.domain.domain
  mail_from_domain = "bounce.${aws_ses_domain_identity.domain.domain}"
}

resource "aws_route53_record" "example_ses_domain_mail_from_mx" {
  zone_id = data.aws_route53_zone.selected.zone_id
  name    = aws_ses_domain_mail_from.domain.mail_from_domain
  type    = "MX"
  ttl     = "600"
  records = ["10 feedback-smtp.us-east-1.amazonses.com"] # Change to the region in which `aws_ses_domain_identity.example` is created
}

# Example Route53 TXT record for SPF
resource "aws_route53_record" "example_ses_domain_mail_from_txt" {
  zone_id = data.aws_route53_zone.selected.zone_id
  name    = aws_ses_domain_mail_from.domain.mail_from_domain
  type    = "TXT"
  ttl     = "300"
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_ses_email_identity" "email" {
  for_each = var.emails
  email    = "${each.key}@${var.domain}"
}

resource "aws_ses_domain_mail_from" "email" {
  for_each         = aws_ses_email_identity.email
  domain           = "${each.key}@${var.domain}"
  mail_from_domain = aws_ses_domain_mail_from.domain.mail_from_domain
}

resource "aws_iam_user" "user" {
  for_each = var.emails
  name     = "${var.prefix}-${each.key}-email"
}

resource "aws_iam_user_policy" "policy" {
  for_each = var.emails
  name     = "${var.prefix}-${each.key}-email"
  user     = "${var.prefix}-${each.key}-email"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "ses:SendRawEmail",
        ]
        Effect   = "Allow"
        Resource = aws_ses_email_identity.email[each.key].arn
      },
    ]
  })
}

resource "aws_iam_access_key" "smtp" {
  for_each = var.emails
  user     = "${var.prefix}-${each.key}-email"
}

