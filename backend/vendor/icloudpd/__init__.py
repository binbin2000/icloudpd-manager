# Minimal icloudpd shim so pyicloud_ipd can import icloudpd.paths.
# The real icloudpd is installed as a PyInstaller binary wheel and does not
# expose its Python submodules.  Only the symbols actually used by
# pyicloud_ipd are provided here.
