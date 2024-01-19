data "aws_route53_zone" "selected" {
  name  = "${var.domain}."
}

resource "aws_route53_record" "dkim" {
  zone_id = data.aws_route53_zone.selected.zone_id
  name    = "${element(aws_ses_domain_dkim.dkim.dkim_tokens, 0)}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = "1800"
  records = ["${element(aws_ses_domain_dkim.dkim.dkim_tokens, 0)}.dkim.amazonses.com"]

}

resource "aws_route53_record" "verification" {
  zone_id = data.aws_route53_zone.selected.zone_id
  name    = "_amazonses.${var.domain}"
  type    = "TXT"
  ttl     = "600"
  records = [aws_ses_domain_identity.domain.verification_token]
}

resource "aws_route53_record" "mx" {
  zone_id = data.aws_route53_zone.selected.zone_id
  name    = var.domain
  type    = "MX"
  ttl     = "600"
  records = ["10 inbound-smtp.${var.aws_region}.amazonaws.com"]
}
