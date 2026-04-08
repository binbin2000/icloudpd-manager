"""Path functions — vendored from icloudpd v1.32.2 src/icloudpd/paths.py"""

import os


def remove_unicode_chars(value: str) -> str:
    """Removes unicode chars from the string"""
    result = value.encode("utf-8").decode("ascii", "ignore")
    return result


def clean_filename(filename: str) -> str:
    """Replaces invalid chars in filenames with '_'"""
    invalid = '<>:"/\\|?*\0'
    result = filename
    for char in invalid:
        result = result.replace(char, "_")
    return result


def local_download_path(filename: str, download_dir: str) -> str:
    """Returns the full download path, including size"""
    return os.path.join(download_dir, filename)
