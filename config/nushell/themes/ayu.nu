# Retrieve the theme settings
export def main [] {
    return {
        binary: '#f07178'
        block: '#39bae6'
        cell-path: '#bfbdb6'
        closure: '#ffb454'
        custom: '#bfbdb6'
        duration: '#d2a6ff'
        float: '#d2a6ff'
        glob: '#95e6cb'
        int: '#d2a6ff'
        list: '#95e6cb'
        nothing: '#d95757'
        range: '#f29668'
        record: '#95e6cb'
        string: '#aad94c'

        bool: '#d2a6ff'

        datetime: {|| (date now) - $in |
            if $in < 1hr {
                { fg: '#d95757' attr: 'b' }
            } else if $in < 6hr {
                '#d95757'
            } else if $in < 1day {
                '#e6b450'
            } else if $in < 3day {
                '#aad94c'
            } else if $in < 1wk {
                { fg: '#aad94c' attr: 'b' }
            } else if $in < 6wk {
                '#95e6cb'
            } else if $in < 52wk {
                '#39bae6'
            } else { '#5a6673' }
        }

        filesize: {|e|
            if $e == 0b {
                '#bfbdb6'
            } else if $e < 1mb {
                '#95e6cb'
            } else {{ fg: '#39bae6' }}
        }

        shape_and: { fg: '#f29668' attr: 'b' }
        shape_binary: { fg: '#f29668' attr: 'b' }
        shape_block: { fg: '#39bae6' attr: 'b' }
        shape_bool: '#d2a6ff'
        shape_closure: { fg: '#ffb454' attr: 'b' }
        shape_custom: '#ffb454'
        shape_datetime: { fg: '#d2a6ff' attr: 'b' }
        shape_directory: '#95e6cb'
        shape_external: '#ffb454'
        shape_external_resolved: '#ffb454'
        shape_externalarg: { fg: '#aad94c' attr: 'b' }
        shape_filepath: '#95e6cb'
        shape_flag: { fg: '#59c2ff' attr: 'b' }
        shape_float: { fg: '#d2a6ff' attr: 'b' }
        shape_garbage: { fg: '#bfbdb6' bg: '#d95757' attr: 'b' }
        shape_glob_interpolation: { fg: '#95e6cb' attr: 'b' }
        shape_globpattern: { fg: '#95e6cb' attr: 'b' }
        shape_int: { fg: '#d2a6ff' attr: 'b' }
        shape_internalcall: { fg: '#ffb454' attr: 'b' }
        shape_keyword: { fg: '#ff8f40' attr: 'b' }
        shape_list: { fg: '#95e6cb' attr: 'b' }
        shape_literal: '#d2a6ff'
        shape_match_pattern: '#aad94c'
        shape_matching_brackets: { attr: 'u' }
        shape_nothing: '#d95757'
        shape_operator: '#f29668'
        shape_or: { fg: '#f29668' attr: 'b' }
        shape_pipe: { fg: '#f29668' attr: 'b' }
        shape_range: { fg: '#f29668' attr: 'b' }
        shape_raw_string: { fg: '#aad94c' attr: 'b' }
        shape_record: { fg: '#95e6cb' attr: 'b' }
        shape_redirection: { fg: '#f29668' attr: 'b' }
        shape_signature: { fg: '#59c2ff' attr: 'b' }
        shape_string: '#aad94c'
        shape_string_interpolation: { fg: '#95e6cb' attr: 'b' }
        shape_table: { fg: '#39bae6' attr: 'b' }
        shape_vardecl: { fg: '#bfbdb6' attr: 'u' }
        shape_variable: '#bfbdb6'

        foreground: '#bfbdb6'
        background: '#0b0e14'
        cursor: '#e6b450'

        empty: '#39bae6'
        header: { fg: '#aad94c' attr: 'b' }
        hints: '#5a6673'
        leading_trailing_space_bg: { attr: 'n' }
        row_index: { fg: '#aad94c' attr: 'b' }
        search_result: { fg: '#bfbdb6' bg: '#4c4126' }
        separator: '#475266'
    }
}

# Update the Nushell configuration
export def --env "set color_config" [] {
    $env.config.color_config = (main)
}

# Update terminal colors
export def "update terminal" [] {
    let theme = (main)

    # Set terminal colors
    let osc_screen_foreground_color = '10;'
    let osc_screen_background_color = '11;'
    let osc_cursor_color = '12;'

    $"
    (ansi -o $osc_screen_foreground_color)($theme.foreground)(char bel)
    (ansi -o $osc_screen_background_color)($theme.background)(char bel)
    (ansi -o $osc_cursor_color)($theme.cursor)(char bel)
    "
    # Line breaks above are just for source readability
    # but create extra whitespace when activating. Collapse
    # to one line and print with no-newline
    | str replace --all "\n" ''
    | print -n $"($in)\r"
}

export module activate {
    export-env {
        set color_config
        update terminal
    }
}

# Activate the theme when sourced
use activate
