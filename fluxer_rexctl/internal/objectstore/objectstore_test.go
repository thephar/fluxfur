// SPDX-License-Identifier: AGPL-3.0-or-later

package objectstore

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net/url"
	"testing"
)

func TestClassify(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		code    string
		message string
		want    Problem
	}{
		{"aws wrong secret", 403, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided. Check your key and signing method.", Credentials},
		{"aws unknown key", 403, "InvalidAccessKeyId", "The AWS Access Key Id you provided does not exist in our records.", Credentials},
		{"aws denied", 403, "AccessDenied", "Access Denied", Denied},
		{"aws wrong region", 400, "AuthorizationHeaderMalformed", "The authorization header is malformed; the region 'us-east-1' is wrong; expecting 'eu-west-1'", WrongRegion},
		{"aws missing bucket", 404, "NoSuchBucket", "The specified bucket does not exist", MissingBuckets},
		{"garage wrong secret", 403, "AccessDenied", "Forbidden: Invalid signature", Credentials},
		{"garage unknown key", 403, "AccessDenied", "Forbidden: No such key: GK0123456789abcdef", Credentials},
		{"garage denied", 403, "AccessDenied", "Forbidden: Operation is not allowed for this key.", Denied},
		{"r2 malformed key", 400, "InvalidArgument", "Credential access key has length 3, should be 32", Credentials},
		{"r2 unauthorized", 401, "Unauthorized", "Unauthorized", Credentials},
		{"b2 unknown key", 403, "InvalidAccessKeyId", "Malformed Access Key Id", Credentials},
		{"head missing bucket", 404, "404 Not Found", "", MissingBuckets},
	}
	for _, c := range cases {
		if got := classify(c.status, c.code, c.message); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestTransportProblem(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want Problem
	}{
		{"unknown authority", &url.Error{Op: "Put", Err: &tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}}, Untrusted},
		{"wrong name", &url.Error{Op: "Put", Err: &tls.CertificateVerificationError{Err: x509.HostnameError{Certificate: &x509.Certificate{}, Host: "s3.example.com"}}}, WrongName},
		{"expired", &url.Error{Op: "Put", Err: x509.CertificateInvalidError{Reason: x509.Expired}}, Untrusted},
		{"refused", &url.Error{Op: "Put", Err: errors.New("connection refused")}, Unreachable},
	}
	for _, c := range cases {
		if got := transportProblem(c.err); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}
