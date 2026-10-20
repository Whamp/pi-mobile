ICU-LICENSE.txt is the upstream Unicode ICU notice from
https://github.com/unicode-org/icu/blob/ad484f3d6c036ba06193ac7c3bc2233a53ab68b8/LICENSE.

The SHA-pinned Termux libicu 78.3 archive ships a 14-byte `404: Not Found`
response as its LICENSE file. Runtime staging replaces that broken file with
this vendored upstream notice; builds do not fetch a moving license URL.
