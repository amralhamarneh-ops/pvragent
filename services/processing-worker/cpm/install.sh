#!/bin/sh
# Downloads only pinned upstream libraries; no job or project files are sent.
set -eu
target=${1:?Provide an absolute installation directory}
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
case "$target" in /*) ;; *) echo 'Installation directory must be absolute' >&2; exit 1;; esac
mkdir -p "$target/lib" "$target/classes" "$target/source"
cd "$target"
base=https://repo.maven.apache.org/maven2
get() {
    rel=$1
    file=$2
    sha=$3
    if ! printf '%s  %s\n' "$sha" "$file" | sha256sum -c --status; then
      curl -fSsL --retry 2 --max-time 90 "$base/$rel" -o "$file"
    fi
    printf '%s  %s\n' "$sha" "$file" | sha256sum -c
}
get net/sf/mpxj/mpxj/16.9.0/mpxj-16.9.0.jar lib/mpxj.jar ee8aae2af2a25970b92543948f993be8312cf31609775bef6f353c4a42442cee
get net/sf/mpxj/mpxj/16.9.0/mpxj-16.9.0-sources.jar source/mpxj-16.9.0-sources.jar 2992cae7a7ccd1e848fcf26cc179c99cb7eef2577887c64ca36a6f096c0abc90
get jakarta/xml/bind/jakarta.xml.bind-api/3.0.1/jakarta.xml.bind-api-3.0.1.jar lib/jaxb-api.jar b8fb4bee3ff5b5c1ef77144d8411316018d7bbd41fcf1ede0646f7978546b867
get org/jsoup/jsoup/1.23.1/jsoup-1.23.1.jar lib/jsoup.jar 8b15e2b28eeb1e0a88a9b7dab4dc0c23524491c56959785dea22f7846897b668
name=org/mpxj/cpm/PrimaveraScheduler.java
mkdir -p "source/$(dirname "$name")"
unzip -p source/mpxj-16.9.0-sources.jar "$name" | tr -d '\r' > "source/$name"
(cd source && patch -p1 -F0 < "$here/vendor/retained-ff-narrow.patch")
if command -v javac >/dev/null 2>&1; then
    javac --release 17 -cp "$target/lib/mpxj.jar" -d "$target/classes" "source/$name"
else
    java -m jdk.compiler/com.sun.tools.javac.Main -source 17 -target 17 -cp "$target/lib/mpxj.jar" -d "$target/classes" "source/$name"
fi
cp "$here/vendor/LGPL-2.1.txt" "$here/vendor/NOTICE.txt" "$here/vendor/retained-ff-narrow.patch" source/
java -cp "$target/classes:$target/lib/*" "$here/RetainedFinishFinishCheck.java"
